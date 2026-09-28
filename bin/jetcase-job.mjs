#!/usr/bin/env node
// jetcase careful read -- the routine's only way to talk to jetcase.
// No dependencies (Node 18+ fetch). Everything it writes stays in ./work,
// inside the routine's own sandbox, and is gone when the run ends.
//
//   node bin/jetcase-job.mjs start <job token>   save the token, fetch the job -> work/job.json
//   node bin/jetcase-job.mjs download            every file -> work/files/, index in work/files.json
//   node bin/jetcase-job.mjs pending             files not yet in the ledger (work/ledger/*.jsonl)
//   node bin/jetcase-job.mjs check work/result.json    jetcase's checks, nothing saved
//   node bin/jetcase-job.mjs submit work/result.json
//   node bin/jetcase-job.mjs fail "reason"
//   node bin/jetcase-job.mjs test                a test run: report tool versions, read nothing
//
// jetcase's address comes ONLY from the environment's JETCASE_URL, never
// from the job text -- so a run can't be pointed anywhere else.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORK = path.resolve(process.cwd(), 'work');
const TOKEN_FILE = path.join(WORK, '.token');

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
  console.log(`${job.categories.length} categories, ${job.files.length} files. Details in work/job.json.`);
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
  await progress('reading', ledgerIds().size, job.files.length);
  console.log(`Downloaded ${ok} of ${job.files.length} files into work/files/. Index (id -> local path) in work/files.json.`);
}

// The ledger: one JSON object per line, one line per file, in
// work/ledger/*.jsonl (one file per batch, so parallel helpers never write
// the same file). Only `id` matters here; the skill defines the rest.
function ledgerIds() {
  const dir = path.join(WORK, 'ledger');
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try { const e = JSON.parse(line); if (e && e.id) ids.add(e.id); } catch { console.error(`  ${f} line ${i + 1} is not valid JSON -- fix it`); }
    });
  }
  return ids;
}

async function cmdPending() {
  const job = JSON.parse(fs.readFileSync(path.join(WORK, 'job.json'), 'utf8'));
  if (job.kind !== 'read') die('A test run has no files.');
  const done = ledgerIds();
  const left = job.files.filter(f => !done.has(f.id));
  await progress('reading', job.files.length - left.length, job.files.length);
  console.log(`${job.files.length - left.length} of ${job.files.length} files are in the ledger; ${left.length} still to read.`);
  left.forEach(f => console.log(`  ${f.id}\t${f.folderPath ? f.folderPath + '/' : ''}${f.name}`));
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
const run = { start: () => cmdStart(arg), download: cmdDownload, pending: cmdPending, check: () => cmdCheck(arg), submit: () => cmdSubmit(arg), fail: () => cmdFail(arg), test: cmdTest }[cmd];
if (!run) {
  console.log('usage: node bin/jetcase-job.mjs start <token> | download | pending | check <result.json> | submit <result.json> | fail "<reason>" | test');
  process.exit(1);
}
run().catch(err => die(err.message));
