# jetcase AI worker

The files a law firm's **Claude Code routine** uses for jetcase's long AI
jobs: the ones that read a whole folder and take minutes, not seconds. It
runs in the firm's own claude.ai account, on the firm's own Claude plan. It
holds no secrets, no jetcase code and no client data.

Each kind of job is one skill in `.claude/skills/`. Today there is one:
- **`careful-medical-checklist`**: open every document in one plaintiff's
  Medical Records folder, count each date of service, and report the
  checklist back to jetcase.

More kinds (demand drafts, whole-file questions) will be added here as
skills. The firm's routine stays the same.

| File | What it is |
|---|---|
| `ROUTINE_PROMPT.md` | The routine's instructions. Paste it into the routine. |
| `setup.sh` | The cloud environment's setup script. It installs poppler, tesseract and ocrmypdf. |
| `.claude/skills/careful-medical-checklist/SKILL.md` | How to read the folder and what to report. |
| `bin/jetcase-job.mjs` | The only way the routine talks to jetcase. It has no dependencies. |

How a run works:
1. jetcase starts the routine with a one-time job token.
2. The routine runs `node bin/jetcase-job.mjs start <token>`, then
   `download`, reads everything, and runs `submit work/result.json`.
   Each file's entry is saved in jetcase as it is read (`save` /
   `pending`), so a run that is cut short loses at most one batch, and the
   next run reads only what's left.
3. jetcase checks the result against the firm's own checklist categories
   and saves it on the plaintiff's card.

The token works only for that one plaintiff, and only until the job ends.
It stays valid while the routine is working (6 hours from its latest call,
24 hours at most).

Setup steps for a firm: in jetcase, **Admin > Medical checklist > Careful
read**. jetcase's own copy of the full guide is `docs/CAREFUL-READ-ONBOARDING.md`.

Published at https://github.com/ntangtrakul-hash/jetcase-ai-worker, so firms' routines can clone it without access to
jetcase's code.

Its source of truth is `ai-worker/` in the jetcase repo. To
publish a change, run this from the jetcase repo:

```bash
git subtree push --prefix=ai-worker https://github.com/ntangtrakul-hash/jetcase-ai-worker.git main
```
