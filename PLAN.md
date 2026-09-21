# Productive Quick Sub-task: Chrome extension

## Context

Creating a sub-task in the Productive UI copies every subscriber from the parent task onto the sub-task and notifies them. On client projects that means client contacts get a notification every time Bryan breaks his own work into steps. The workaround today is not creating sub-tasks.

This extension adds two one-click actions on a Productive task page: **Quiet** (sub-task assigned to me, no subscribers) and **Team** (sub-task assigned to me, subscribers limited to 4Site staff who were on the parent). Both create the sub-task through the API with an explicit subscriber list, then open it.

**The acceptance test is a negative one: nobody outside the intended list ever receives a notification.** A version that creates the sub-task and then strips subscribers fails, because the notifications already went out. That is why Phase 0 comes before any extension code.

Repo: `4site-interactive-studios/chrome-productive-sub-task-creation` (public, empty except README). Branch: `claude/practical-babbage-5kz9jp`.

## Constraints discovered during planning

**This session cannot reach Productive.** The remote environment's egress proxy returns 403 for every `*.productive.io` host (`api`, `developer`, `help`, `app`). So no spec download, no API calls, no live testing from here. Confirmed by direct probe and the proxy's own failure log. Phase 0 therefore runs on Bryan's laptop; the script is written here, run there, results pasted back. (If that gets tiresome, the environment's network policy can be widened: https://code.claude.com/docs/en/claude-code-on-the-web.)

**The vendor request shape is genuinely uncertain.** The docs list `subscriber_ids`, `assignee_id`, `parent_task_id` as writable *attributes*. But two independent public clients build the same fields as JSON:API *relationships* instead: `@pipedream/productive_io` sends `relationships.project` / `relationships.task_list`, and `@studiometa/productive-api` sends `relationships.assignee` and `relationships.workflow_status` (`{data: {type: "workflow_statuses", id}}`). Neither covers subscribers. Phase 0 settles this empirically by trying both forms rather than guessing.

**Task URLs (from Bryan's real links):**

| Shape | Example |
|---|---|
| Full page | `app.productive.io/2650-4site-interactive-studios-inc/tasks/20251762` |
| Over a list or board | `app.productive.io/2650-4site-interactive-studios-inc/tasks/task/20251762?filter=<base64>` |
| Sub-task | identical to full page (`.../tasks/20251769`) |

A sub-task's URL is indistinguishable from a parent's, so "is this already a sub-task?" has to come from the API, not the URL. The `filter` payload decodes to a saved view that filters on `assignee_id: ["32510"]` and `workflow_status_category_id: ["1","2"]`, which corroborates the status-category model and suggests 32510 is Bryan's person ID. The extension still resolves that ID from his email rather than hard-coding it.

## Phase 0: spike, run by Bryan, before extension code

One dependency-free script, `scripts/phase0.mjs` (Node 18+, global `fetch`), reading `PRODUCTIVE_TOKEN` from the environment. Never committed with a token in it. Read-only unless `--create` is passed. Everything it creates is titled `[phase0] <row> <timestamp>` and recorded to a local scratch file so `--cleanup` can delete exactly those and nothing else.

**Bryan sets up first:** a sandbox parent task in an internal project, with one willing 4Site colleague as a subscriber. For the watcher run, that colleague also watches the project. The colleague should expect real notifications from this, several of them, and will be asked what landed.

### Read-only probes (no `--create`)

| # | Probe | Proves |
|---|---|---|
| R1 | `GET /tasks/20251762` | Whether the number in the web URL is the API task id. Dumps `project`, `task_list`, `service`, `workflow_status`, `parent_task` as the API actually returns them (attributes vs relationships). |
| R2 | `GET /tasks/{id}` with candidate `include=` values (`subscribers`, `subscribed_people`, `followers`) | How subscribers are exposed on a task, if at all. |
| R3 | `GET /people?filter[subscribable_id]={id}&filter[subscribable_type]=X` over candidates (`Task`, `task`, `tasks`, `Tasks`) | The correct `subscribable_type` value. Unknown #5. |
| R4 | `GET /people?filter[email]=bryan@4sitestudios.com` | My person ID, and the person payload's shape. |
| R5 | People census: counts by `hrm_type_id`, `person_type`, email domain, `company_id` | Which signal cleanly separates 4Site staff from client contacts. Prints aggregates, not a roster dump. |
| R6 | Parent's `workflow_status` → its workflow → `GET` that workflow's statuses with `category_id` and `position` | That "first not-started status" is derivable, and by which endpoint. |
| R7 | Download the OpenAPI spec locally, extract and print only the tasks POST/PATCH request body schema and the people filter list | Exact field names, without dumping a huge file. |
| R8 | Echo any `X-RateLimit-*` / `Retry-After` headers seen | Unknown #7. A third-party client assumes ~100 req/10s and honors `Retry-After`; unconfirmed. |

### Create matrix (`--create`), each row read back for its subscriber list

| Row | Request shape | Proves |
|---|---|---|
| A | subscribers omitted | Whether inheritance is server-side (unknown #1). If A comes back with the parent's subscribers, the server does it. |
| B | `attributes.subscriber_ids: []` | Whether an explicit empty list is honored or treated as omitted (unknown #2). |
| C | `attributes.subscriber_ids: [me]` | Whether an explicit list wins outright. |
| D | `relationships.subscribers: {data: []}` | Same as B in relationship form. |
| E | `relationships.subscribers: {data: [me]}` | Same as C in relationship form. |
| F | Convert fallback: POST parentless with no subscribers → read subscribers → `PATCH parent_task_id` → read again | Whether conversion adds subscribers or notifies (the documented escape hatch). |
| G | Winning shape, in a project the colleague watches | Whether watchers are force-added server-side (unknown #3). |
| H | Winning shape, `service_id` omitted, parent has a service | Whether service is inherited (unknown #4). |
| I | Winning shape, parent is itself a sub-task | Whether nesting is supported (unknown #6). |

After each run Bryan asks the colleague what notifications arrived. **Stop and report the table before writing extension code.** If no shape produces zero unwanted notifications, stop and say so rather than shipping a create-then-clean-up version.

## Extension design

Plain JavaScript, no dependencies, no framework, Node only for tooling. Structure mirrors `chrome-auto-pin-tabs`: ES modules in `src/`, concatenated by `build.mjs` into classic generated files at the root, which is what Chrome loads.

```
manifest.json          MV3, fixed "key" for a stable extension ID
background.js          GENERATED from src/ by build.mjs, never hand-edited
content.js             GENERATED from src/ (shares the URL parser with the worker)
options.html/.js       token, title template, allowlist, Test connection
icons/                 16/32/48/128
src/productive-url.js  pure: parseTaskUrl(href) -> {orgSlug, taskId} | null
src/team.js            pure: isTeamMember(person, rule) / filterTeamSubscribers(people, rule)
src/api.js             fetch wrapper: auth headers, JSON:API errors, 429 retry (no chrome.*)
src/storage.js         chrome.storage.local wrapper, defaults merged on read
src/subtask.js         the create flow, given an api client
src/service-worker.js  message router, chrome.commands
src/content-ui.js      widget, toast, SPA URL watching
build.mjs              src/ -> background.js + content.js, gated by `node --check`
package.json           tooling only, version kept in sync with manifest.json
.githooks/pre-commit   version parity + rebuild and stage generated files
README.md LICENSE .gitignore
```

Generating `content.js` as well as `background.js` is the one extension to the sibling's build: it keeps the URL parser a single source function, which the prompt asks for, instead of duplicating it across worker and page.

Not included, since this is a personal unpacked install: `build-store.mjs`, `dist/`, `STORE.md`, `PRIVACY.md`. Say the word if you want a Web Store path and they get added.

**Manifest:** `host_permissions: ["https://api.productive.io/*"]`, content script on `https://app.productive.io/*`, `permissions: ["storage"]`, `commands` for the two shortcuts, `options_ui.open_in_tab`. No `"type": "module"` on the background entry, matching the sibling: the build ships a single classic worker. A fresh `key.pem` gets generated during implementation, its public half goes in `manifest.json`, and `key.pem` is gitignored. Since the session is ephemeral and nothing is being published, losing the private half costs nothing; the `key` field alone pins the ID for unpacked loads.

**Where work happens.** All API calls run in the service worker, so the page's CORS rules and Productive's own session are irrelevant. The content script sends `{type: "createSubtask", href, variant, title}` and gets `{ok: true, taskId}` or `{ok: false, error}` back, matching the sibling's message contract (every async branch returns `true`; failures come back as `{ok: false, error}` rather than throwing).

**Auth.** Personal API token entered on the options page, stored in `chrome.storage.local`, never logged, never read from the page's session. "Test connection" resolves the person ID from `bryan@4sitestudios.com` and caches it.

### Create flow

1. `parseTaskUrl(href)` → `{orgSlug, taskId}`, or fail loudly. The parser requires host `app.productive.io`, a `tasks` segment, and an all-digits id either directly after it or after an intervening `task` segment. Anything else returns `null` and the widget stays hidden. Already checked in Node against all three real URLs and against decoys (`/tasks`, `/tasks/task`, `/tasks/new`, `/projects/3192`, a lookalike host): the three parse, the decoys return `null`. One open question for the first browser test: whether clicking an inner tab inside a task (comments, time, sub-tasks) appends a path segment, since `/tasks/20251762/todos` currently returns `null` and would hide the widget.
2. `GET` the parent for project, task list, service, workflow status, and whether it already has a parent.
3. Guards: private parent → stop with the documented reason (private tasks cannot have sub-tasks); already a sub-task → stop if Phase 0 row I shows nesting is unsupported.
4. Workflow status: parent's status → its workflow → first status with category 1, lowest position. Never the parent's current status. Cached per workflow with a TTL and a "clear caches" button in options.
5. Subscribers. Quiet: empty. Team: fetch the parent's subscribers (per R2/R3), run `filterTeamSubscribers`.
6. Create using the Phase 0-selected shape, with `assignee` = me, `service` copied from the parent if H shows it is not inherited, `parent_task_id` set, and the title.
7. Read the new task back and compare actual subscribers against intended. Mismatch → warning toast naming the extra people. Never silently fix.
8. Navigate the tab to `https://app.productive.io/{orgSlug}/tasks/{newId}`, using the slug from the current URL rather than a hard-coded one.

**Title.** Quiet creates immediately with the template (`Sub-task of #{parent number}`, editable in options). **Team opens a one-field prompt first**, so the people who get notified see a real title and no second notification follows a rename.

**4Site membership rule**, one function, default: active people whose email ends in `@4sitestudios.com`, plus an allowlist of person IDs from options for contractors on other domains. If R5 shows `hrm_type_id = 1` or a Productive Team is a cleaner signal for the actual data, I will report that with the Phase 0 table and we decide before it is written.

**Failure handling.** 401 → "token rejected"; 403 → "token lacks permission on this project"; 422 → Productive's `errors[].detail` verbatim; 429 → one retry honoring `Retry-After`, then an error toast. Errors log as `console.warn("[productive-subtask] …", e)` and never throw across a boundary.

**UI.** A fixed-position widget with two buttons, shown only when the URL parses as a task. No injection into Ember's DOM, whose class names are unstable. SPA navigation is watched by polling `location.href` on a short interval plus `popstate`, not by observing app internals. Buttons disable while a request is in flight, and the worker also guards per-tab, so a double-click cannot create two sub-tasks.

## Verification

Phase 0 is verified by the colleague's report of what notifications arrived, not by the API response alone.

For the extension, Bryan does the in-browser checks and I give exact click-by-click steps and expected results for each case: token missing / wrong / unauthorized project; parent with no subscribers, with only client subscribers, with Bryan as the only subscriber; parent with no service; parent closed; parent already a sub-task; a project with a watcher; full-page vs over-a-list URLs; navigating between tasks without a reload; two fast clicks. Scratch Node checks cover the URL parser (all three real URL shapes plus non-task pages) and the subscriber filter; per the prompt they stay scratch and do not become committed test files.

Per 4Site's code protocol, every code change is preceded by a verification certificate (premises, execution trace, logic verification, divergence analysis), abbreviated for changes under ~10 lines.

The README documents install-unpacked steps, token generation, options, shortcuts, and the Phase 0 findings, so the shape of the create call is explained rather than mysterious.

## Sequence

1. **Done.** `scripts/phase0.mjs`, `PHASE0.md`, `.gitignore` and a README stub are written, syntax-checked, and exercised by 21 scratch assertions over the payload builder, the task normalizer and the status picker. Committed locally as `918afd3`.
2. **Blocked.** The push was refused: *Claude doesn't have GitHub access to `4site-interactive-studios/chrome-productive-sub-task-creation` for your organization.* Both files were sent to Bryan directly so Phase 0 is not gated on fixing that. Commit `918afd3` gets pushed the moment access is granted.
3. Bryan runs Phase 0 on his laptop and pastes back the output plus the notification answers.
4. We pick the create shape and the staff rule from that result.
5. Build the extension against it, push, and hand over click-by-click test steps.

## Bryan's runbook

### Track A: unblock the push (optional, two minutes, do it any time)

An org admin installs the Claude GitHub App on this repo at https://github.com/apps/claude/installations/select_target, or Bryan reconnects GitHub at https://claude.ai/customize/connectors?auth_start=github&auth_start_force=1. Nothing else waits on this.

### Track B: run Phase 0

Needs Node 18 or newer and about 20 minutes, most of it Productive setup.

1. **Sandbox.** A task in an **internal** project, with a service set and exactly one other subscriber. A second account Bryan controls beats a colleague: the notification check becomes his own inbox and the run is repeatable. Task id is the URL's last segment.
2. **Token.** Settings, API integrations, Generate new token. Exported as `PRODUCTIVE_TOKEN`, never pasted into chat.
3. **Script.** `phase0.mjs` saved anywhere; its ledger and spec download land beside it.
4. **Read-only:** `spec`, `read --task <id>`, `people`. Nothing is created.
5. **Dry run:** `matrix --parent <id>` prints all eleven payloads and sends none.
6. **Armed:** the second account starts watching the project, then `matrix --parent <id> --yes`. Two minutes, including the 45-second delayed re-read.
7. **Report back:** all four outputs, plus a yes or no per line of the notification checklist the run prints.
8. **Cleanup:** `cleanup`, then `cleanup --yes`.

Expected stumbles: a 404 on the parent means the URL number is not the API task id, which is itself finding R1. A 401 means the token is wrong, a 403 means the token's user lacks permission on that project. "REFUSING TO ARM" means more than three people besides Bryan could be notified, so the sandbox needs fewer subscribers or the project has watchers worth knowing about first.
