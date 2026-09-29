#!/usr/bin/env node
// jetcase careful read -- the routine's only way to talk to jetcase.
// No dependencies (Node 18+ fetch). Everything it writes stays in ./work,
// inside the routine's own sandbox, and is gone when the run ends.
//
//   node bin/jetcase-job.mjs start <job token>   save the token, fetch the job -> work/job.json
//   node bin/jetcase-job.mjs download            every file -> work/files/, index in work/files.json
//   node bin/jetcase-job.mjs save [ledger file]  send new/changed ledger lines to jetcase (saved at once)
//   node bin/jetcase-job.mjs pending             save, then list files not yet in the ledger (work/ledger/*.jsonl)
//   node bin/jetcase-job.mjs assemble            ledger + category notes -> work/result.json
//   node bin/jetcase-job.mjs check work/result.json    jetcase's checks, nothing saved
//   node bin/jetcase-job.mjs submit work/result.json
//   node bin/jetcase-job.mjs fail "reason"
//   node bin/jetcase-job.mjs test                a test run: report tool versions, read nothing
//
// jetcase's address comes ONLY from the environment's JETCASE_URL, never
// from the job text -- so a run can't be pointed anywhere else.
//
// Entries are saved in jetcase as the ledger grows (save, and pending runs
// it first), so a run that dies -- the token expires, the session ends --
// loses at most the batch it was on. Running "start" again (same token), or
// the next careful read, lists only the files not saved yet.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORK = path.resolve(process.cwd(), 'work');
const TOKEN_FILE = path.join(WORK, '.token');
const SAVE_CHUNK = 25;

function die(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function base() {
  const raw = (process.env.JETCASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) die('JETCASE_URL is not set in this cloud environment. Ask the firm admin to add it (Admin > Medical checklist in jetcase shows the value).');
  let u;
  try { u = new URL(raw); } catch { die('JETCASE_URL is not a valid URL: ' + raw); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) die('JETCASE_URL must be https.');
  return raw + '/api/ai-worker';
}

function token() {
  if (!fs.existsSync(TOKEN_FILE)) die('No job yet -- run "start <job token>" first.');
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

async function call(method, p, { body, raw } = {}) {
  const headers = { Authorization: 'Bearer ' + token() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let resp;
  for (let attempt = 1; ; attempt++) {
    try {
      resp = await fetch(base() + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (err) {
      if (attempt < 4) { await new Promise(r => setTimeout(r, attempt * 3000)); continue; }
      die(`Could not reach jetcase (${err.message}). Check the environment's network access allows the JETCASE_URL host.`);
    }
    if (resp.status >= 500 && attempt < 4) { await new Promise(r => setTimeout(r, attempt * 3000)); continue; }
    break;
  }
  if (raw && resp.ok) return resp;
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  if (resp.status === 401) {
    die('This job has ended or its token has expired. Everything already saved stays in jetcase, and the next careful read continues from there. Stop here: do not retry or report anything else.');
  }
  if (!resp.ok) {
    const e = new Error((data && data.error) || `HTTP ${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return data;
}

// Tells jetcase what the run is doing, for the checklist card's status line.
// Best effort: a failed report never stops the run.
async function progress(phase, done, total) {
  try {
    const headers = { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' };
    await fetch(base() + '/progress', { method: 'POST', headers, body: JSON.stringify({ phase, done, total }) });
  } catch { /* ignore */ }
}

function safeName(s) {
  return String(s).replace(/[^\w.() -]/g, '_').slice(0, 150);
}

async function cmdStart(tok) {
  const t = String(tok || '').trim();
  if (!/^jcr_[A-Za-z0-9_-]{20,}$/.test(t)) die('That is not a jetcase job token (it starts with jcr_).');
  fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  const job = await call('GET', '/job').catch(e => die(e.message));
  fs.writeFileSync(path.join(WORK, 'job.json'), JSON.stringify(job, null, 2));
  if (job.kind === 'test') {
    console.log('This is a TEST run. Run "node bin/jetcase-job.mjs test" and stop.');
    return;
  }
  console.log(`Job ${job.jobId}: matter ${job.ourFile}, plaintiff "${job.plaintiffName || '(single plaintiff)'}"`);
  const c = job.counts || { total: job.files.length, toRead: job.files.length, known: 0 };
  console.log(`${job.categories.length} categories. ${c.total} files in the folder: ${c.toRead} to read, ${c.known} already read (see "known" in work/job.json -- do NOT open those again).`);
  if (!job.files.length) console.log('Nothing new to read. Judge the folder from "known", write work/category-notes.json if needed, then run assemble, check and submit.');
  if (c.savedThisJob) console.log(`${c.savedThisJob} of them were already saved by this job before a restart -- they are under "known" and are not to be read again.`);
  const big = job.files.filter(f => f.tooLarge);
  if (big.length) console.log(`${big.length} file(s) over 60MB cannot be downloaded -- list them as unreadable: ${big.map(f => f.name).join(', ')}`);
}

async function cmdDownload() {
  const job = JSON.parse(fs.readFileSync(path.join(WORK, 'job.json'), 'utf8'));
  if (job.kind !== 'read') die('A test run has no files.');
  const dir = path.join(WORK, 'files');
  fs.mkdirSync(dir, { recursive: true });
  const index = [];
  let ok = 0;
  await progress('downloading', 0, job.files.length);
  let n = 0;
  for (const f of job.files) {
    if (++n % 20 === 0) await progress('downloading', n, job.files.length);
    const local = path.join(dir, f.id.slice(-12).replace(/[^\w-]/g, '_') + '__' + safeName(f.name));
    const entry = { id: f.id, name: f.name, folderPath: f.folderPath, size: f.size, local: path.relative(process.cwd(), local), error: null };
    if (f.tooLarge) { entry.error = 'larger than 60MB'; index.push(entry); continue; }
    if (fs.existsSync(local) && fs.statSync(local).size === f.size) { ok++; index.push(entry); continue; }
    try {
      const resp = await call('GET', '/files/' + encodeURIComponent(f.id), { raw: true });
      fs.writeFileSync(local, Buffer.from(await resp.arrayBuffer()));
      ok++;
    } catch (err) {
      entry.error = err.message;
      console.error(`  could not download ${f.name}: ${err.message}`);
    }
    index.push(entry);
  }
  fs.writeFileSync(path.join(WORK, 'files.json'), JSON.stringify(index, null, 2));
  const before = (job.counts && job.counts.savedThisJob) || 0;
  await progress('reading', before + ledgerIds().size, before + job.files.length);
  console.log(`Downloaded ${ok} of ${job.files.length} files into work/files/. Index (id -> local path) in work/files.json.`);
}

// The ledger: one JSON object per line, one line per file, in
// work/ledger/*.jsonl (one file per batch, so parallel helpers never write
// the same file). Only `id` matters here; the skill defines the rest.
// @returns Map id -> { entry, line, file } (a later line for a file wins)
function readLedger({ only = null, strict = false } = {}) {
  const dir = path.join(WORK, 'ledger');
  const byId = new Map();
  if (!fs.existsSync(dir)) return byId;
  const names = only ? [path.basename(only)] : fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort();
  for (const f of names) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) die(`No ledger file ${path.relative(process.cwd(), p)}.`);
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      let e;
      try { e = JSON.parse(line); } catch {
        if (strict) die(`${f} line ${i + 1} is not valid JSON -- fix it and run assemble again.`);
        console.error(`  ${f} line ${i + 1} is not valid JSON -- fix it`);
        return;
      }
      if (e && e.id) byId.set(e.id, { entry: e, line: line.trim(), file: f });
    });
  }
  return byId;
}

function ledgerIds() {
  return new Set(readLedger().keys());
}

// What was already sent, per ledger file (work/saved/<batch>.json: id ->
// line hash), so parallel helpers never write the same state file and a
// changed line is sent again.
function savedState(ledgerFile) {
  const p = path.join(WORK, 'saved', ledgerFile.replace(/\.jsonl$/, '') + '.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* none yet */ }
  return { state, write: () => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(state)); } };
}

function hashLine(line) {
  let h = 0;
  for (let i = 0; i < line.length; i++) h = (Math.imul(h, 31) + line.charCodeAt(i)) | 0;
  return String(h >>> 0) + ':' + line.length;
}

// Sends new or changed ledger lines to jetcase, where they are saved at
// once. A rejected line is named with the reason: fix it in the ledger and
// save again. @returns { sent, saved, rejected, savedThisJob, toRead }
async function saveLedger(only = null, { quiet = false } = {}) {
  const job = JSON.parse(fs.readFileSync(path.join(WORK, 'job.json'), 'utf8'));
  if (job.kind !== 'read') die('A test run has no files.');
  const want = new Set(job.files.map(f => f.id));
  const byFile = new Map();
  for (const [id, x] of readLedger({ only })) {
    if (!want.has(id)) continue;
    if (!byFile.has(x.file)) byFile.set(x.file, []);
    byFile.get(x.file).push(x);
  }
  const out = { sent: 0, saved: 0, rejected: [], savedThisJob: null, toRead: null };
  for (const [file, lines] of byFile) {
    const st = savedState(file);
    const fresh = lines.filter(x => st.state[x.entry.id] !== hashLine(x.line));
    for (let i = 0; i < fresh.length; i += SAVE_CHUNK) {
      const chunk = fresh.slice(i, i + SAVE_CHUNK);
      const res = await call('POST', '/entries', { body: { entries: chunk.map(x => x.entry) } });
      const bad = new Set(res.rejected.map(r => r.id));
      chunk.forEach(x => { if (!bad.has(x.entry.id)) st.state[x.entry.id] = hashLine(x.line); });
      st.write();
      out.sent += chunk.length;
      out.saved += res.saved;
      out.rejected.push(...res.rejected.map(r => Object.assign({ ledger: file }, r)));
      out.savedThisJob = res.savedThisJob;
      out.toRead = res.toRead;
    }
  }
  if (!quiet || out.sent) {
    if (out.sent) console.log(`Saved ${out.saved} of ${out.sent} new or changed ledger line(s) in jetcase${out.savedThisJob != null ? ` (${out.savedThisJob} of ${out.toRead} files to read saved so far)` : ''}.`);
    else console.log('Nothing new to save.');
  }
  if (out.rejected.length) {
    console.log(`REJECTED ${out.rejected.length} line(s) -- fix them in the ledger and run save again:`);
    out.rejected.forEach(r => console.log(`  ${r.ledger}: ${r.name || r.id}: ${r.error}`));
  }
  return out;
}

async function cmdSave(file) {
  await saveLedger(file || null);
}

async function cmdPending() {
  const job = JSON.parse(fs.readFileSync(path.join(WORK, 'job.json'), 'utf8'));
  if (job.kind !== 'read') die('A test run has no files.');
  // Save first, so the ledger is in jetcase before anything else can fail.
  let rejected = [];
  try { rejected = (await saveLedger(null, { quiet: true })).rejected; } catch (err) { console.error(`  could not save to jetcase (${err.message}) -- run save again later`); }
  // A line jetcase rejected is still to do: it has to be fixed and saved.
  const done = ledgerIds();
  rejected.forEach(r => done.delete(r.id));
  const left = job.files.filter(f => !done.has(f.id));
  // Counted over every file this job was given, including the ones saved
  // before a restart, so the card's "N of M" never goes backwards.
  const before = (job.counts && job.counts.savedThisJob) || 0;
  await progress('reading', before + job.files.length - left.length, before + job.files.length);
  console.log(`${job.files.length - left.length} of ${job.files.length} files are in the ledger and saved; ${left.length} still to read${rejected.length ? ` (${rejected.length} of them rejected -- fix the line)` : ''}.`);
  left.forEach(f => console.log(`  ${f.id}\t${f.folderPath ? f.folderPath + '/' : ''}${f.name}`));
}

// Builds work/result.json from the ledger (every line of work/ledger/*.jsonl
// is one file's entry) plus the optional work/category-notes.json,
// work/flags.json and work/notes.txt -- so the result is never retyped by
// hand, and jetcase builds the checklist from the entries.
async function cmdAssemble() {
  const job = JSON.parse(fs.readFileSync(path.join(WORK, 'job.json'), 'utf8'));
  const byId = new Map([...readLedger({ strict: true })].map(([id, x]) => [id, x.entry]));
  if (job.kind === 'read') {
    try { await saveLedger(null, { quiet: true }); } catch (err) { console.error(`  could not save to jetcase (${err.message}) -- the result still carries every entry`); }
  }
  const readJson = (name, fallback) => {
    const p = path.join(WORK, name);
    if (!fs.existsSync(p)) return fallback;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { die(`${name} is not valid JSON: ${err.message}`); }
  };
  const want = new Set(job.files.map(f => f.id));
  const entries = [...byId.values()].filter(e => want.has(e.id));
  const extra = [...byId.keys()].filter(id => !want.has(id));
  const notesPath = path.join(WORK, 'notes.txt');
  const result = {
    entries,
    categoryNotes: readJson('category-notes.json', {}),
    flags: readJson('flags.json', []),
    notes: fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim().slice(0, 2000) : '',
  };
  fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`Wrote work/result.json: ${entries.length} of ${job.files.length} files to read have an entry.`);
  if (extra.length) console.log(`Ignored ${extra.length} ledger line(s) for files not in this job's "files" (already-read files keep their stored entry).`);
  const missing = job.files.filter(f => !byId.has(f.id));
  if (missing.length) console.log(`Still missing an entry: ${missing.length} -- run pending.`);
}

async function cmdCheck(file) {
  if (!file || !fs.existsSync(file)) die('Give the path to the result JSON.');
  let body;
  try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { die('The result file is not valid JSON: ' + err.message); }
  try {
    await progress('checking', null, null);
    const out = await call('POST', '/check', { body });
    console.log('CHECK PASSED (nothing saved yet): ' + JSON.stringify(out.summary));
    if (out.summary.unknownDocs && out.summary.unknownDocs.length) console.log('Unknown documents (fix the ids/names): ' + out.summary.unknownDocs.join('; '));
  } catch (err) {
    die(`CHECK FAILED: ${err.message}\nFix work/result.json and run check again.`);
  }
}

async function cmdSubmit(file) {
  if (!file || !fs.existsSync(file)) die('Give the path to the result JSON.');
  let body;
  try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { die('The result file is not valid JSON: ' + err.message); }
  try {
    const out = await call('POST', '/result', { body });
    console.log('Saved in jetcase: ' + JSON.stringify(out.summary));
  } catch (err) {
    die(`jetcase rejected the result (${err.status || '?'}): ${err.message}\nFix the result file and submit again.`);
  }
}

async function cmdFail(reason) {
  await call('POST', '/fail', { body: { reason: String(reason || '').slice(0, 1000) } }).catch(e => die(e.message));
  console.log('Reported to jetcase as failed.');
}

function version(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0].trim(); } catch { return 'missing'; }
}

async function cmdTest() {
  const tools = {
    node: process.version,
    pdftotext: version('pdftotext', ['-v']) === 'missing' ? 'missing' : 'ok',
    pdftoppm: version('pdftoppm', ['-v']) === 'missing' ? 'missing' : 'ok',
    tesseract: version('tesseract', ['--version']),
    ocrmypdf: version('ocrmypdf', ['--version']),
  };
  const out = await call('POST', '/result', { body: { tools, notes: 'Test run from the careful read routine.' } }).catch(e => die(e.message));
  console.log('Test reported to jetcase: ' + JSON.stringify(out.summary));
  const missing = Object.entries(tools).filter(([, v]) => v === 'missing').map(([k]) => k);
  if (missing.length) console.log('Missing tools (the setup script did not install them): ' + missing.join(', '));
}

const [cmd, arg] = process.argv.slice(2);
const run = { start: () => cmdStart(arg), download: cmdDownload, save: () => cmdSave(arg), pending: cmdPending, assemble: cmdAssemble, check: () => cmdCheck(arg), submit: () => cmdSubmit(arg), fail: () => cmdFail(arg), test: cmdTest }[cmd];
if (!run) {
  console.log('usage: node bin/jetcase-job.mjs start <token> | download | save [ledger file] | pending | assemble | check <result.json> | submit <result.json> | fail "<reason>" | test');
  process.exit(1);
}
run().catch(err => die(err.message));
