# Handoff: Productive Quick Sub-task extension

## What is in this zip

| Path | What it is |
|---|---|
| `repo/` | The working tree as it stands: `scripts/phase0.mjs`, `PHASE0.md`, `README.md`, `.gitignore` |
| `patches/` | The two commits as git patches, messages and authorship intact |
| `repo.bundle` | The same two commits as a git bundle, if you would rather pull than apply patches |
| `PLAN.md` | The full plan, including the extension design and every decision with its reasoning |
| `HANDOFF.md` | This file. The prompt to paste is at the bottom |

Those commits exist nowhere else. A cloud session wrote them and could not push, because GitHub refused with
"Claude doesn't have GitHub access to this repository for your organization."

## Getting set up

**The branch does not exist on GitHub.** `git ls-remote` shows only `main`, sitting at the same initial commit
these two commits are based on. So there is nothing to check out. You create the branch locally and apply the
work to it.

**Path A, from the real repo (recommended):**

```
git clone https://github.com/4site-interactive-studios/chrome-productive-sub-task-creation
cd chrome-productive-sub-task-creation
git checkout -b claude/practical-babbage-5kz9jp
git am /path/to/patches/0001-*.patch /path/to/patches/0002-*.patch
git log --oneline -3
git push -u origin claude/practical-babbage-5kz9jp
```

`git am` replays the commits, so the hashes differ from the originals while messages and authorship carry over.
Verified on a fresh clone: both patches apply and the script runs afterward.

**Path B, straight from the bundle:**

```
git clone -b claude/practical-babbage-5kz9jp /path/to/repo.bundle chrome-productive-sub-task-creation
cd chrome-productive-sub-task-creation
git remote set-url origin https://github.com/4site-interactive-studios/chrome-productive-sub-task-creation
git push -u origin claude/practical-babbage-5kz9jp
```

This keeps the original hashes, `918afd3` and `76706a7`. The `-b` flag is required: the bundle carries no HEAD
and the clone fails without it. Also verified.

**To teleport the cloud session's conversation into your terminal, push first.** Teleport fetches the session's
branch from the remote, and until you push, there is no branch for it to find. After pushing, from a clean
checkout and signed in to the same claude.ai account:

```
claude --teleport session_01WdMzEbc5914o6SVXUuSrLP
```

That loads the full conversation history. The terminal copy becomes its own session; work there does not flow
back to the cloud one.

**Or skip git entirely.** Copy `repo/scripts/phase0.mjs` and `repo/PHASE0.md` wherever you like and run them.
Phase 0 does not touch the repo.

## The prompt

Start Claude Code in the repo, then paste everything below.

---

I'm building a Chrome MV3 extension for my own use in Productive (app.productive.io). Read `PHASE0.md` and `scripts/phase0.mjs` before anything else. `PLAN.md` has the full design if it is in this directory.

**The problem.** Creating a sub-task in Productive's UI copies every subscriber from the parent onto the sub-task and notifies them, client contacts included. The extension puts two buttons on a task page. Quiet: a sub-task assigned to me with no subscribers. Team: assigned to me, with subscribers limited to the parent's subscribers who work at 4Site. Both create through the API with an explicit subscriber list, then open the new sub-task.

**The acceptance test is a negative one: nobody outside the intended list may ever receive a notification.** Creating the sub-task and then stripping subscribers fails, because the mail has already gone out. If no approach passes, tell me and stop. Do not ship a create-then-clean-up version.

**Where things stand.** `scripts/phase0.mjs` is written, syntax-checked, and its pure functions pass 21 scratch assertions. It has never been run against the API. No extension code exists. The script was written in a cloud session whose network could not reach productive.io, so every claim about how the API behaves is unverified. You can reach it from here, which is the point of this move.

**What to do first.** Ask me for the sandbox parent task id, then with `PRODUCTIVE_TOKEN` exported, run the three read-only commands: `spec`, `read --task <id>`, `people`. Then the dry run, `matrix --parent <id>`, which prints eleven payloads and sends none. Only after I confirm the sandbox is set up, run the armed `matrix --parent <id> --yes`. Report the results table and stop before writing extension code. I supply the notification answers by hand, because a clean subscriber array does not prove that no mail was sent. That human answer is the finding.

**Verified from Productive's docs.** Base `https://api.productive.io/api/v2/`, JSON:API, `Content-Type: application/vnd.api+json`. Auth is `X-Auth-Token` plus `X-Organization-Id`, org `2650`, and 403 means the token's user lacks permission. `POST /tasks` requires title, project, task list and workflow status; `parent_task_id` makes it a sub-task. Project watchers are auto-subscribed to every new task. A sub-task inherits the parent's service only if it was set at creation. Private tasks cannot have sub-tasks. Confirmed first-party by github.com/productiveio/api_client: the base URL, both headers, and the fact that `Task` declares no associations there, which means creates through the official gem send flat `*_id` attributes.

**Still unverified, which is what Phase 0 settles.** Whether parent-subscriber inheritance is the web app pre-filling the field or the server adding it. Whether an empty subscriber list is honored or treated as omitted. Whether project watchers are forced on over an explicit list. Whether the service is copied automatically. The correct `subscribable_type` value for tasks. Whether sub-tasks of sub-tasks are allowed. Rate limits.

**Decisions already made, do not relitigate.** Manifest V3, plain JavaScript, no dependencies, no framework. A build step is allowed: ES modules in `src/` concatenated into the classic `background.js` and `content.js` that Chrome loads, mirroring github.com/4site-interactive-studios/chrome-auto-pin-tabs. API calls run in the service worker, never the page. Token in `chrome.storage.local`, never `sync`, never logged, never read out of the page's session. My person id is resolved from `bryan@4sitestudios.com`, not hard-coded. Quiet creates immediately with a template title; Team asks for a title first, so the people who get notified see a real one. The new task's status is the first category-1 status in the parent's workflow by position, never a copy of the parent's current status. After creating, read the task back and warn if the subscribers differ from what was intended, naming the extras, and never silently fix it.

**Task URL shapes, from real links.** `app.productive.io/2650-4site-interactive-studios-inc/tasks/20251762` and `.../tasks/task/20251762?filter=<base64>`. A sub-task's URL looks identical to a parent's, so whether a task already has a parent has to come from the API. The parser is one function, rejects anything else rather than guessing, and is already checked against all three real URLs plus decoys.

**How I want you to work.** Match the sibling repo's conventions: double quotes, semicolons, two-space indent, a `// filename.js` header and a paragraph explaining each file's role, comments that say why rather than what, `{type, ...}` messages answered with `{ok: true, ...}` or `{ok: false, error}`, errors logged and never thrown across a boundary, and pure logic kept free of `chrome.*` so it runs in plain Node. Use the 4site-standards skill for code work, which means a verification certificate before any code block. Keep scratch checks scratch; they do not become committed test files. Verify by running things, and tell me exactly what to click when you need me to check something in the browser.
