// scripts/phase0.mjs
// Phase 0 spike for the Productive sub-task extension. It answers the questions the vendor docs
// don't: whether a sub-task inherits the parent's subscribers because the web app pre-fills them
// or because the server adds them, whether an explicit subscriber list suppresses that, whether
// project watchers are forced on regardless, and which JSON:API wire form the create endpoint
// actually accepts. Nothing here ships. buildTaskPayload() below is the function the extension
// will use, ported verbatim once a wire form wins, so it is written to be portable, not clever.
//
// The governing rule: a subscriber list read back from the API is not the notification list. A row
// can come back with a perfect empty array and still have sent mail. So every task this script
// creates carries a unique title token, and the run ends with a ledger a human can answer
// per-row: "which of these did you get an email about?" That answer is the verdict.
//
// Read-only by default. Creating requires the "matrix" subcommand AND --yes. Deleting only ever
// touches ids this script wrote to .phase0-ledger.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE_URL = "https://api.productive.io/api/v2";
const SPEC_URL = "https://developer.productive.io/reference/download_spec";
const ORG_ID = process.env.PRODUCTIVE_ORG || "2650";
const TOKEN = process.env.PRODUCTIVE_TOKEN || "";
const MY_EMAIL = process.env.PRODUCTIVE_EMAIL || "bryan@4sitestudios.com";

const LEDGER_PATH = fileURLToPath(new URL("./.phase0-ledger.json", import.meta.url));
const SPEC_PATH = fileURLToPath(new URL("./.phase0-spec.json", import.meta.url));

const PAGE_SIZE = 200;          // JSON:API page[size]; Productive's max is not documented
const PAGE_CAP = 20;            // pages, so a big org can't run away with the people census
const SLOW_MS = 3000;           // gap between creates, so the recipient's timeline is ordered
const RECHECK_MS = 45000;       // gap before the t1 re-read that catches deferred fan-out
const MAX_NOTIFIABLE = 3;       // people who could be mailed before the matrix refuses to arm
const RETRY_CAP_MS = 15000;     // ceiling on an honored Retry-After

// Rate limits are undocumented. One third-party client assumes ~100 requests / 10s and honors
// Retry-After; this script records whatever headers come back instead of testing the ceiling.
const observedHeaders = new Map();

const args = process.argv.slice(2);
const cmd = args[0] || "help";
const has = (name) => args.includes("--" + name);
const flag = (name, fallback = null) => {
  const i = args.indexOf("--" + name);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runId = Math.random().toString(36).slice(2, 6);

// --- HTTP ----------------------------------------------------------------------------------

async function api(method, path, body, attempt = 0) {
  const url = path.startsWith("http") ? path : BASE_URL + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
        "X-Auth-Token": TOKEN,
        "X-Organization-Id": ORG_ID
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    return { status: 0, doc: null, raw: "", error: String(e) };
  }

  for (const [k, v] of res.headers) {
    if (/rate|limit|retry|request-id/i.test(k)) observedHeaders.set(k, v);
  }

  // One retry only. A 429 provably did nothing, so retrying it is safe; anything else is not.
  if (res.status === 429 && attempt === 0) {
    const wait = retryAfterMs(res.headers.get("Retry-After"));
    console.log("  429 on " + method + " " + path + " - waiting " + wait + "ms, retrying once");
    await sleep(wait);
    return api(method, path, body, 1);
  }

  const raw = await res.text();
  let doc = null;
  try { doc = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body; raw is kept */ }
  return { status: res.status, doc, raw, error: null };
}

function retryAfterMs(header) {
  if (!header) return 5000;
  const secs = parseInt(header, 10);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, RETRY_CAP_MS);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), RETRY_CAP_MS);
  return 5000;
}

// Productive's message, verbatim. Paraphrasing it here would hide exactly the detail that tells
// us the payload shape is wrong.
function errorText(r) {
  if (r.error) return r.error;
  const errs = r.doc && r.doc.errors;
  if (Array.isArray(errs) && errs.length) {
    return errs.map((e) => [e.title, e.detail, e.source && e.source.pointer].filter(Boolean).join(" / ")).join("; ");
  }
  return (r.raw || "").slice(0, 200);
}

async function getAll(path, params = {}) {
  const items = [];
  for (let page = 1; page <= PAGE_CAP; page++) {
    const qs = new URLSearchParams({ ...params, "page[number]": String(page), "page[size]": String(PAGE_SIZE) });
    const r = await api("GET", path + "?" + qs.toString());
    if (r.status !== 200 || !r.doc) return { ok: false, status: r.status, items, error: errorText(r) };
    items.push(...(r.doc.data || []));
    const total = (r.doc.meta && r.doc.meta.total_pages) || 1;
    if (page >= total) break;
  }
  return { ok: true, status: 200, items, error: null };
}

// --- JSON:API shapes -----------------------------------------------------------------------

const str = (v) => (v === null || v === undefined ? null : String(v));

function relId(res, name) {
  const d = res && res.relationships && res.relationships[name] && res.relationships[name].data;
  if (Array.isArray(d)) return d.map((x) => String(x.id));
  return d ? String(d.id) : null;
}

// Reads a task whichever way the API represents it. Which side of each "??" wins is itself a
// Phase 0 finding, so the raw attribute keys get printed alongside.
export function normalizeTask(res) {
  const a = (res && res.attributes) || {};
  const subsRel = relId(res, "subscribers");
  return {
    id: String(res.id),
    title: a.title,
    number: a.task_number ?? a.number ?? null,
    private: a.private ?? null,
    closed: a.closed ?? null,
    projectId: relId(res, "project") ?? str(a.project_id),
    taskListId: relId(res, "task_list") ?? str(a.task_list_id),
    workflowStatusId: relId(res, "workflow_status") ?? str(a.workflow_status_id),
    serviceId: relId(res, "service") ?? str(a.service_id),
    parentTaskId: relId(res, "parent_task") ?? str(a.parent_task_id),
    assigneeId: relId(res, "assignee") ?? str(a.assignee_id),
    subscriberIds: (Array.isArray(subsRel) ? subsRel : null) ??
      (Array.isArray(a.subscriber_ids) ? a.subscriber_ids.map(String) : null)
  };
}

function normalizePerson(res) {
  const a = (res && res.attributes) || {};
  return {
    id: String(res.id),
    email: a.email || "",
    name: [a.first_name, a.last_name].filter(Boolean).join(" "),
    hrmTypeId: a.hrm_type_id ?? null,
    personType: a.person_type ?? null,
    status: a.status ?? null,
    companyId: relId(res, "company") ?? str(a.company_id)
  };
}

// The payload builder under test, and the one the extension will inherit. "both" deliberately
// sends conflicting subscriber lists so the read-back says which form the server honors - a 201
// alone proves nothing, because an unrecognized field is silently dropped.
export function buildTaskPayload(spec, wireForm) {
  const attributes = { title: spec.title };
  if (spec.description) attributes.description = spec.description;
  const relationships = {};

  const put = (attrKey, relKey, relType, value) => {
    if (value === undefined || value === null) return;
    if (wireForm === "flat" || wireForm === "both") attributes[attrKey] = String(value);
    if (wireForm === "rel" || wireForm === "both") {
      relationships[relKey] = { data: { type: relType, id: String(value) } };
    }
  };

  put("project_id", "project", "projects", spec.projectId);
  put("task_list_id", "task_list", "task_lists", spec.taskListId);
  put("workflow_status_id", "workflow_status", "workflow_statuses", spec.workflowStatusId);
  put("parent_task_id", "parent_task", "tasks", spec.parentTaskId);
  put("assignee_id", "assignee", "people", spec.assigneeId);
  put("service_id", "service", "services", spec.serviceId);

  if (spec.subscriberIds !== undefined) {
    const ids = spec.subscriberIds.map(String);
    if (wireForm === "flat") {
      attributes.subscriber_ids = ids;
    } else if (wireForm === "rel") {
      relationships.subscribers = { data: ids.map((id) => ({ type: "people", id })) };
    } else {
      attributes.subscriber_ids = ids;
      relationships.subscribers = { data: [] };
    }
  }

  const data = { type: "tasks", attributes };
  if (Object.keys(relationships).length) data.relationships = relationships;
  return { data };
}

// --- discovery -----------------------------------------------------------------------------

async function resolveMe() {
  const qs = new URLSearchParams({ "filter[email]": MY_EMAIL });
  const r = await api("GET", "/people?" + qs.toString());
  if (r.status !== 200 || !r.doc || !(r.doc.data || []).length) {
    return { ok: false, error: "person lookup for " + MY_EMAIL + " returned " + r.status + ": " + errorText(r) };
  }
  return { ok: true, person: normalizePerson(r.doc.data[0]) };
}

const INCLUDE_CANDIDATES = [
  "subscribers", "subscribed_people", "followers", "watchers",
  "assignee", "workflow_status", "task_list", "project", "service", "parent_task", "creator"
];

// Each include is probed on its own request. One bad value 400s the whole call, so combining
// them during discovery would tell us nothing about which value was the bad one.
async function probeIncludes(taskId) {
  const rows = [];
  for (const inc of INCLUDE_CANDIDATES) {
    const r = await api("GET", "/tasks/" + taskId + "?include=" + inc);
    const included = (r.doc && r.doc.included) || [];
    const rel = r.status === 200 ? relId(r.doc.data, inc) : null;
    rows.push({
      include: inc,
      status: r.status,
      included: included.length,
      types: [...new Set(included.map((x) => x.type))].join(","),
      rel: Array.isArray(rel) ? "[" + rel.length + "]" : rel ? "id" : "-",
      error: r.status === 200 ? "" : errorText(r).slice(0, 80)
    });
  }
  return rows;
}

const SUBSCRIBABLE_TYPES = ["task", "tasks", "Task", "Tasks", "Task::Task"];

// An API that ignores an unknown filter returns everyone, which reads as success. So each
// candidate's count is compared against the unfiltered total, and equality is flagged.
async function probeSubscribableType(taskId, totalPeople) {
  const rows = [];
  for (const path of ["/people", "/subscriptions"]) {
    for (const type of SUBSCRIBABLE_TYPES) {
      const qs = new URLSearchParams({
        "filter[subscribable_id]": String(taskId),
        "filter[subscribable_type]": type,
        "page[size]": String(PAGE_SIZE)
      });
      const r = await api("GET", path + "?" + qs.toString());
      const count = r.status === 200 && r.doc ? (r.doc.data || []).length : null;
      rows.push({
        path,
        type,
        status: r.status,
        count: count === null ? "-" : String(count),
        verdict: r.status !== 200 ? "error"
          : count === totalPeople && totalPeople > 0 ? "IGNORED? (== all people)"
          : count === 0 ? "empty"
          : "populated",
        error: r.status === 200 ? "" : errorText(r).slice(0, 80)
      });
    }
  }
  return rows;
}

// Tries each known access path in turn and reports which one answered, so every result row can
// record how its subscriber list was obtained rather than implying they are interchangeable.
async function readSubscribers(taskId) {
  const viaInclude = await api("GET", "/tasks/" + taskId + "?include=subscribers");
  if (viaInclude.status === 200 && viaInclude.doc) {
    const ids = relId(viaInclude.doc.data, "subscribers");
    if (Array.isArray(ids)) return { ids: ids.sort(numeric), via: "include" };
    const attr = viaInclude.doc.data.attributes && viaInclude.doc.data.attributes.subscriber_ids;
    if (Array.isArray(attr)) return { ids: attr.map(String).sort(numeric), via: "attribute" };
  }
  for (const type of SUBSCRIBABLE_TYPES) {
    const qs = new URLSearchParams({
      "filter[subscribable_id]": String(taskId),
      "filter[subscribable_type]": type,
      "page[size]": String(PAGE_SIZE)
    });
    const r = await api("GET", "/people?" + qs.toString());
    if (r.status === 200 && r.doc && Array.isArray(r.doc.data)) {
      return { ids: r.doc.data.map((x) => String(x.id)).sort(numeric), via: "people:" + type };
    }
  }
  return { ids: null, via: "unreadable" };
}

const numeric = (a, b) => Number(a) - Number(b);

// The extension has to pick a "not started" status without copying the parent's. That means
// walking from the parent to its workflow, and which hop carries workflow_id is unknown.
async function workflowChain(task) {
  const out = { statusId: task.workflowStatusId, workflowId: null, statuses: [], notes: [] };
  if (!task.workflowStatusId) {
    out.notes.push("parent has no workflow_status - cannot derive a workflow");
    return out;
  }
  const st = await api("GET", "/workflow_statuses/" + task.workflowStatusId);
  if (st.status !== 200 || !st.doc) {
    out.notes.push("GET /workflow_statuses/" + task.workflowStatusId + " -> " + st.status + ": " + errorText(st));
  } else {
    const a = st.doc.data.attributes || {};
    out.workflowId = relId(st.doc.data, "workflow") ?? str(a.workflow_id);
    out.notes.push("status attrs: " + Object.keys(a).join(", "));
  }
  if (!out.workflowId) {
    const tl = await api("GET", "/task_lists/" + task.taskListId);
    if (tl.status === 200 && tl.doc) {
      const a = tl.doc.data.attributes || {};
      out.workflowId = relId(tl.doc.data, "workflow") ?? str(a.workflow_id);
      out.notes.push("task_list rels: " + Object.keys(tl.doc.data.relationships || {}).join(", "));
    }
  }
  if (out.workflowId) {
    const qs = new URLSearchParams({ "filter[workflow_id]": out.workflowId, "page[size]": String(PAGE_SIZE) });
    const r = await api("GET", "/workflow_statuses?" + qs.toString());
    if (r.status === 200 && r.doc) {
      out.statuses = (r.doc.data || []).map((x) => ({
        id: String(x.id),
        name: x.attributes.name,
        category: x.attributes.category_id ?? x.attributes.category ?? null,
        position: x.attributes.position ?? null
      }));
    } else {
      out.notes.push("status list -> " + r.status + ": " + errorText(r));
    }
  }
  return out;
}

export function pickNotStartedStatus(statuses) {
  const open = statuses.filter((s) => String(s.category) === "1");
  if (!open.length) return null;
  open.sort((a, b) => (Number(a.position) - Number(b.position)) || numeric(a.id, b.id));
  return open[0];
}

async function projectWatchers(projectId) {
  const qs = new URLSearchParams({ "filter[project_watching]": String(projectId), "page[size]": String(PAGE_SIZE) });
  const r = await api("GET", "/people?" + qs.toString());
  if (r.status !== 200 || !r.doc) return { ok: false, error: r.status + ": " + errorText(r), people: [] };
  return { ok: true, people: (r.doc.data || []).map(normalizePerson) };
}

// --- ledger --------------------------------------------------------------------------------

function ledgerRead() {
  if (!existsSync(LEDGER_PATH)) return [];
  try { return JSON.parse(readFileSync(LEDGER_PATH, "utf8")); } catch { return []; }
}

// Written synchronously the instant a task exists, before any follow-up read. A crash mid-matrix
// must never orphan a task whose id only lived in memory.
function ledgerAdd(entry) {
  const all = ledgerRead();
  all.push(entry);
  writeFileSync(LEDGER_PATH, JSON.stringify(all, null, 2) + "\n");
}

function ledgerWrite(all) {
  writeFileSync(LEDGER_PATH, JSON.stringify(all, null, 2) + "\n");
}

// --- commands ------------------------------------------------------------------------------

async function cmdSpec() {
  console.log("Downloading the OpenAPI spec (no auth needed)...");
  let text = "";
  try {
    const res = await fetch(SPEC_URL, { headers: { Accept: "application/json" } });
    text = await res.text();
    console.log("  HTTP " + res.status + ", " + text.length + " bytes");
  } catch (e) {
    console.log("  download failed: " + String(e));
    return;
  }
  writeFileSync(SPEC_PATH, text);
  console.log("  saved to " + SPEC_PATH);

  let spec = null;
  try { spec = JSON.parse(text); } catch {
    console.log("\nNot JSON. First 200 characters, so we can tell what it is:\n" + text.slice(0, 200));
    console.log("\nThe file is saved; paste the head of it back and we will grep it another way.");
    return;
  }

  const deref = (node, depth = 0) => {
    while (node && node.$ref && depth < 8) {
      const parts = node.$ref.replace(/^#\//, "").split("/");
      let cur = spec;
      for (const p of parts) cur = cur && cur[p.replace(/~1/g, "/").replace(/~0/g, "~")];
      node = cur;
      depth++;
    }
    return node;
  };

  const describe = (schema, depth = 0) => {
    const s = deref(schema);
    if (!s || depth > 4) return [];
    const lines = [];
    const props = s.properties || {};
    for (const [name, raw] of Object.entries(props)) {
      const p = deref(raw);
      const type = (p && p.type) || (p && p.oneOf ? "oneOf" : "?");
      lines.push("  ".repeat(depth) + name + ": " + type);
      const items = p && p.items ? deref(p.items) || {} : null;
      if (p && (p.properties || (items && items.properties))) {
        lines.push(...describe(p.properties ? p : items, depth + 1));
      }
    }
    return lines;
  };

  for (const [path, method] of [["/tasks", "post"], ["/tasks/{id}", "patch"]]) {
    const op = spec.paths && spec.paths[path] && spec.paths[path][method];
    console.log("\n===== " + method.toUpperCase() + " " + path + " request body =====");
    if (!op) { console.log("  not found in spec (check the exact path key)"); continue; }
    const content = op.requestBody && deref(op.requestBody).content;
    const schema = content && (content["application/vnd.api+json"] || content["application/json"] || Object.values(content)[0]);
    const lines = schema ? describe(schema.schema) : [];
    console.log(lines.length ? lines.join("\n") : "  no schema properties found");
  }

  const peopleOp = spec.paths && spec.paths["/people"] && spec.paths["/people"].get;
  const filters = ((peopleOp && peopleOp.parameters) || [])
    .map((p) => deref(p))
    .map((p) => p && p.name)
    .filter((n) => n && n.startsWith("filter"));
  console.log("\n===== GET /people filter params (" + filters.length + ") =====");
  console.log(filters.length ? filters.join("\n") : "  none enumerated in the spec");

  console.log("\nPaths in the spec mentioning subscri*:");
  console.log(Object.keys(spec.paths || {}).filter((p) => /subscri/i.test(p)).join("\n") || "  none");
}

async function cmdRead(taskId) {
  requireToken();
  if (!taskId || taskId === true) { console.log("read needs --task <taskId>"); return null; }
  console.log("===== R1: GET /tasks/" + taskId + " =====");
  const r = await api("GET", "/tasks/" + taskId);
  if (r.status !== 200 || !r.doc) {
    console.log("  HTTP " + r.status + ": " + errorText(r));
    console.log("  If this is a 404, the number in the web URL is not the API task id - tell me.");
    return null;
  }
  const task = normalizeTask(r.doc.data);
  console.log("  attribute keys: " + Object.keys(r.doc.data.attributes || {}).join(", "));
  console.log("  relationship keys: " + Object.keys(r.doc.data.relationships || {}).join(", "));
  console.log("  normalized: " + JSON.stringify(task, null, 2));

  console.log("\n===== R2: include probes =====");
  const incRows = await probeIncludes(taskId);
  for (const row of incRows) {
    console.log("  " + row.include.padEnd(18) + " " + String(row.status).padEnd(4) +
      " included=" + String(row.included).padEnd(3) + " rel=" + row.rel.padEnd(6) +
      " " + row.types + (row.error ? "  " + row.error : ""));
  }

  const all = await getAll("/people", {});
  const totalPeople = all.items.length;
  console.log("\n===== R3: subscribable_type probes (org has " + totalPeople + " people) =====");
  console.log("  productiveio/api_client declares no subscription resource, only organization_subscription");
  console.log("  (billing). So a 404 on /subscriptions is the expected answer, not a broken probe.");
  const subRows = await probeSubscribableType(taskId, totalPeople);
  for (const row of subRows) {
    console.log("  " + (row.path + " " + row.type).padEnd(28) + " " + String(row.status).padEnd(4) +
      " n=" + row.count.padEnd(5) + " " + row.verdict + (row.error ? "  " + row.error : ""));
  }

  const subs = await readSubscribers(taskId);
  console.log("\n  best subscriber read: via=" + subs.via + " ids=" + JSON.stringify(subs.ids));

  console.log("\n===== R6/P7: workflow chain =====");
  const chain = await workflowChain(task);
  console.log("  workflowId: " + chain.workflowId);
  for (const n of chain.notes) console.log("  note: " + n);
  for (const s of chain.statuses) {
    console.log("    " + s.id.padEnd(8) + " cat=" + String(s.category).padEnd(3) + " pos=" + String(s.position).padEnd(4) + " " + s.name);
  }
  const pick = pickNotStartedStatus(chain.statuses);
  console.log("  first not-started (category 1, lowest position): " + (pick ? pick.id + " " + pick.name : "NONE FOUND"));

  console.log("\n===== P6: project watchers (auto-subscribed to every new task) =====");
  const w = await projectWatchers(task.projectId);
  if (!w.ok) console.log("  " + w.error);
  else if (!w.people.length) console.log("  none");
  else for (const p of w.people) console.log("  " + p.id.padEnd(8) + " " + p.email + " hrm=" + p.hrmTypeId + " type=" + p.personType);

  console.log("\n===== P8: is notification ground truth readable? =====");
  for (const path of ["/notifications?page[size]=1", "/activities?page[size]=1", "/subscriptions?page[size]=1"]) {
    const probe = await api("GET", path);
    console.log("  " + path.split("?")[0].padEnd(16) + " -> " + probe.status +
      (probe.status === 200 ? " OK" : " " + errorText(probe).slice(0, 80)));
  }

  printHeaders();
  return task;
}

async function cmdPeople() {
  requireToken();
  const all = await getAll("/people", {});
  if (!all.ok) { console.log("people fetch failed: " + all.error); return; }
  const people = all.items.map(normalizePerson);
  console.log("===== R5: people census (" + people.length + " people, " + (all.items.length === PAGE_SIZE * PAGE_CAP ? "PAGE CAP HIT" : "complete") + ") =====");

  const tally = (fn) => {
    const m = new Map();
    for (const p of people) {
      const k = String(fn(p));
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const show = (label, rows) => {
    console.log("\n" + label);
    for (const [k, n] of rows) console.log("  " + String(k).padEnd(32) + n);
  };

  const domain = (p) => (p.email.split("@")[1] || "(none)").toLowerCase();
  show("by hrm_type_id (docs: 1 employee, 2 contact)", tally((p) => p.hrmTypeId));
  show("by person_type", tally((p) => p.personType));
  show("by status", tally((p) => p.status));
  show("by email domain", tally(domain));
  show("by company_id", tally((p) => p.companyId));

  console.log("\ncrosstab hrm_type_id x domain (the decision artifact for the staff rule)");
  const cross = new Map();
  for (const p of people) {
    const k = "hrm=" + p.hrmTypeId + " | " + domain(p);
    cross.set(k, (cross.get(k) || 0) + 1);
  }
  for (const [k, n] of [...cross.entries()].sort((a, b) => b[1] - a[1])) {
    console.log("  " + k.padEnd(44) + n);
  }

  const mine = people.filter((p) => domain(p) === "4sitestudios.com");
  console.log("\n@4sitestudios.com: " + mine.length + " people, hrm_type_ids " +
    JSON.stringify([...new Set(mine.map((p) => p.hrmTypeId))]) +
    ", company_ids " + JSON.stringify([...new Set(mine.map((p) => p.companyId))]));
  console.log("Names and addresses are deliberately not printed. Re-run with --show-names if we need them.");
  if (has("show-names")) for (const p of mine) console.log("  " + p.id.padEnd(8) + " " + p.email);
  printHeaders();
}

const ROWS = [
  { id: "R0", form: "flat", parent: "none", subs: undefined, note: "control: what every create gets forced" },
  { id: "R1", form: "flat", parent: "yes", subs: undefined, note: "Q1 is inheritance server-side?" },
  { id: "R2", form: "rel", parent: "yes", subs: undefined, note: "Q1, rel form" },
  { id: "R3", form: "flat", parent: "yes", subs: [], note: "Q2 is an empty list honored?" },
  { id: "R4", form: "rel", parent: "yes", subs: [], note: "Q2, rel form" },
  { id: "R5", form: "flat", parent: "yes", subs: ["me"], note: "Q3 does an explicit list win?" },
  { id: "R6", form: "rel", parent: "yes", subs: ["me"], note: "Q3, rel form" },
  { id: "R7", form: "flat", parent: "convert", subs: ["me"], note: "fallback: create then PATCH parent" },
  { id: "R8", form: "rel", parent: "convert", subs: ["me"], note: "fallback, rel form" },
  { id: "R9", form: "both", parent: "yes", subs: ["me"], note: "precedence: flat [me] vs rel []" },
  { id: "R10", form: null, parent: "nested", subs: ["me"], note: "Q6 sub-task of a sub-task?" }
];

// /activities is a real endpoint: productiveio/api_client declares an Activity resource. If it can
// be filtered down to one task, we get a second, re-runnable read on who the server thinks it told,
// instead of relying on a human checking their mail every time.
async function probeActivities(taskId) {
  console.log("\n===== P8b: can /activities be filtered to one task? =====");
  const attempts = [
    { "filter[item_id]": String(taskId), "filter[item_type]": "task" },
    { "filter[item_id]": String(taskId) },
    { "filter[task_id]": String(taskId) }
  ];
  for (const params of attempts) {
    const qs = new URLSearchParams({ ...params, "page[size]": "20" });
    const r = await api("GET", "/activities?" + qs.toString());
    const items = r.status === 200 && r.doc ? (r.doc.data || []) : [];
    console.log("  " + JSON.stringify(params) + " -> " + r.status + " n=" + items.length +
      (r.status === 200 ? "" : "  " + errorText(r).slice(0, 80)));
    if (items.length) {
      console.log("    attribute keys: " + Object.keys(items[0].attributes || {}).join(", "));
      console.log("    relationship keys: " + Object.keys(items[0].relationships || {}).join(", "));
    }
  }
}

async function cmdMatrix() {
  requireToken();
  const parentId = flag("parent");
  if (!parentId || parentId === true) { console.log("matrix needs --parent <taskId>"); return; }

  const me = await resolveMe();
  if (!me.ok) { console.log(me.error); return; }
  console.log("me: " + me.person.id + " " + me.person.email + " (hrm=" + me.person.hrmTypeId + ")");

  const r = await api("GET", "/tasks/" + parentId);
  if (r.status !== 200 || !r.doc) { console.log("parent read failed: " + r.status + " " + errorText(r)); return; }
  const parent = normalizeTask(r.doc.data);
  const parentSubs = await readSubscribers(parentId);
  const watchers = await projectWatchers(parent.projectId);
  const chain = await workflowChain(parent);
  const openStatus = pickNotStartedStatus(chain.statuses);
  const statusId = openStatus ? openStatus.id : parent.workflowStatusId;

  console.log("\n===== SETUP CHECK =====");
  console.log("  parent " + parent.id + " '" + parent.title + "' project=" + parent.projectId +
    " list=" + parent.taskListId + " service=" + parent.serviceId + " private=" + parent.private +
    " parentOfParent=" + parent.parentTaskId);
  console.log("  parent subscribers (" + parentSubs.via + "): " + JSON.stringify(parentSubs.ids));
  console.log("  project watchers: " + JSON.stringify(watchers.people.map((p) => p.id + " " + p.email)));
  console.log("  status for new tasks: " + statusId + (openStatus ? " (" + openStatus.name + ", category 1)" : " (FALLBACK: parent's own status)"));

  const notifiable = new Set([...(parentSubs.ids || []), ...watchers.people.map((p) => p.id)]);
  notifiable.delete(me.person.id);
  const maxNotifiable = Number(flag("max-notifiable", MAX_NOTIFIABLE));
  console.log("  people other than me who could be mailed by this run: " + notifiable.size);
  if (notifiable.size > maxNotifiable && !has("force")) {
    console.log("\nREFUSING TO ARM. That is more than --max-notifiable (" + maxNotifiable + ").");
    console.log("A sandbox parent should have one willing subscriber, not a crowd. Use --force to override.");
    return;
  }

  const armed = has("yes");
  console.log("\n===== " + (armed ? "CREATING" : "DRY RUN - nothing will be sent") + " =====");
  if (!armed) console.log("Add --yes to actually create. Payloads below are exactly what would be sent.\n");

  const slow = Number(flag("slow", SLOW_MS));
  const results = [];
  let winningForm = null;
  let nestUnder = null;

  for (const row of ROWS) {
    const form = row.form || winningForm || "flat";
    const intent = row.subs === undefined ? "absent" : row.subs.length ? "me" : "empty";
    const title = "ZZPROBE " + runId + " " + row.id + " " + form.toUpperCase() + " " + intent;

    let parentFor;
    if (row.parent === "yes") parentFor = parentId;
    else if (row.parent === "nested") parentFor = nestUnder;
    else parentFor = undefined;

    if (row.parent === "nested" && !parentFor) {
      results.push({ ...row, form, title, status: "-", taskId: "-", t0: "-", skipped: "no clean sub-task to nest under" });
      continue;
    }

    const spec = {
      title,
      projectId: parent.projectId,
      taskListId: parent.taskListId,
      workflowStatusId: statusId,
      assigneeId: me.person.id,
      parentTaskId: parentFor,
      subscriberIds: row.subs === undefined ? undefined : row.subs.map((s) => (s === "me" ? me.person.id : s))
    };
    // R7/R8 create parentless on purpose, then convert with a PATCH.
    if (row.parent === "convert") spec.parentTaskId = undefined;
    // H: service is deliberately NOT sent, so the read-back says whether it is inherited.
    const payload = buildTaskPayload(spec, form);

    if (!armed) {
      console.log(row.id + " " + form + " " + row.note);
      console.log(JSON.stringify(payload));
      console.log("");
      results.push({ ...row, form, title, status: "dry", taskId: "-", t0: "-" });
      continue;
    }

    const created = await api("POST", "/tasks", payload);
    if (created.status < 200 || created.status >= 300 || !created.doc) {
      console.log(row.id + " " + form + " -> HTTP " + created.status + ": " + errorText(created));
      results.push({ ...row, form, title, status: String(created.status), taskId: "-", t0: "-", error: errorText(created).slice(0, 120) });
      await sleep(slow);
      continue;
    }

    const newId = String(created.doc.data.id);
    ledgerAdd({ id: newId, row: row.id, form, title, runId, createdAt: new Date().toISOString(), parentOf: parentFor || null });
    console.log("CREATED " + newId + "  " + title);

    let converted = null;
    if (row.parent === "convert") {
      const before = await readSubscribers(newId);
      const patch = buildTaskPayload({ title, parentTaskId: parentId }, form);
      patch.data.id = newId;
      delete patch.data.attributes.title;
      const p = await api("PATCH", "/tasks/" + newId, patch);
      const after = await readSubscribers(newId);
      converted = { patchStatus: p.status, before: before.ids, after: after.ids, error: p.status >= 300 ? errorText(p).slice(0, 120) : "" };
      console.log("  convert PATCH -> " + p.status + " subs " + JSON.stringify(before.ids) + " -> " + JSON.stringify(after.ids));
    }

    const back = await api("GET", "/tasks/" + newId);
    const norm = back.status === 200 && back.doc ? normalizeTask(back.doc.data) : null;
    const t0 = await readSubscribers(newId);
    results.push({
      ...row, form, title,
      status: String(created.status),
      taskId: newId,
      t0: t0.ids,
      via: t0.via,
      serviceId: norm ? norm.serviceId : "?",
      assigneeId: norm ? norm.assigneeId : "?",
      parentTaskId: norm ? norm.parentTaskId : "?",
      converted
    });

    // R10 nests under the first sub-task that actually got created, and uses the first form that
    // came back clean - falling back to the first form that was merely accepted, so the nesting
    // question still gets answered even when no row is clean.
    const isExplicit = row.parent === "yes" && row.subs && row.subs.length > 0;
    const cleanRow = isExplicit && Array.isArray(t0.ids) && t0.ids.every((id) => id === me.person.id);
    if (isExplicit && (cleanRow || !winningForm)) winningForm = cleanRow ? form : winningForm || form;
    if (!nestUnder && row.parent === "yes") nestUnder = newId;

    await sleep(slow);
  }

  if (armed && !has("no-recheck")) {
    console.log("\nWaiting " + RECHECK_MS + "ms before the t1 re-read. This catches a server that adds");
    console.log("parent subscribers on a delay, which an immediate read-back would call clean.");
    await sleep(RECHECK_MS);
    for (const row of results) {
      if (!row.taskId || row.taskId === "-") continue;
      const t1 = await readSubscribers(row.taskId);
      row.t1 = t1.ids;
    }
  }

  const firstMade = results.find((r) => r.taskId && r.taskId !== "-");
  if (firstMade) await probeActivities(firstMade.taskId);

  printTable(results, me.person.id);
  printLedger(results);
  printVerdict(results, me.person.id, parentSubs.ids || [], watchers.people.map((p) => p.id));
  printHeaders();
}

function fmt(v) {
  if (v === undefined) return "-";
  if (v === null) return "null";
  return Array.isArray(v) ? "[" + v.join(",") + "]" : String(v);
}

function printTable(results, meId) {
  console.log("\n===== RESULTS (me = " + meId + ") =====");
  const head = ["ROW", "FORM", "PARENT", "SENT", "HTTP", "ID", "SUBS t0", "SUBS t1", "SERVICE", "VIA"];
  const rows = results.map((r) => [
    r.id, r.form, r.parent,
    r.subs === undefined ? "absent" : r.subs.length ? "[me]" : "[]",
    r.status, r.taskId, fmt(r.t0), fmt(r.t1), fmt(r.serviceId), r.via || "-"
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
  for (const r of results) {
    if (r.error) console.log("  " + r.id + " error: " + r.error);
    if (r.skipped) console.log("  " + r.id + " skipped: " + r.skipped);
    if (r.converted) console.log("  " + r.id + " convert: PATCH " + r.converted.patchStatus +
      " subs " + fmt(r.converted.before) + " -> " + fmt(r.converted.after) + " " + (r.converted.error || ""));
  }
}

function printLedger(results) {
  const made = results.filter((r) => r.taskId && r.taskId !== "-");
  if (!made.length) return;
  console.log("\n===== NOTIFICATION LEDGER =====");
  console.log("Send this to whoever subscribes to the sandbox parent and ask, per line, whether they");
  console.log("got an email or an in-app notification. This, not the arrays above, is the verdict.\n");
  for (const r of made) console.log("  [ ] " + r.title + "   (task " + r.taskId + ")");
}

function printVerdict(results, meId, parentSubs, watcherIds) {
  const by = (id) => results.find((r) => r.id === id) || {};
  const clean = (r) => Array.isArray(r.t0) && Array.isArray(r.t1 ?? r.t0) &&
    (r.t1 ?? r.t0).every((id) => id === meId);
  const leaked = (r) => Array.isArray(r.t0) &&
    parentSubs.some((id) => id !== meId && (r.t1 ?? r.t0 ?? []).includes(id));

  console.log("\n===== VERDICT (mechanical; confirm against the ledger answers) =====");
  console.log("  watcher floor from R0: " + fmt(by("R0").t0));
  console.log("  R1 (flat, subs absent): " + (leaked(by("R1")) ? "INHERITED parent subs -> server-side" : "no parent subs -> client-side"));
  console.log("  R3/R4 (empty list): " + (clean(by("R3")) ? "flat empty honored " : "flat empty not honored ") +
    "/ " + (clean(by("R4")) ? "rel empty honored" : "rel empty not honored"));
  console.log("  R5/R6 (explicit [me]): " + (clean(by("R5")) ? "flat CLEAN " : "flat dirty ") +
    "/ " + (clean(by("R6")) ? "rel CLEAN" : "rel dirty"));
  console.log("  R9 precedence: sent flat=[me] rel=[] -> got " + fmt(by("R9").t0) +
    " (matches [me] => flat wins; empty => rel wins)");
  console.log("  R10 nesting: HTTP " + (by("R10").status || "-"));

  const direct = clean(by("R5")) || clean(by("R6"));
  const convert = by("R7").converted && Array.isArray(by("R7").converted.after) &&
    by("R7").converted.after.every((id) => id === meId);
  if (direct) console.log("\n  STRATEGY: direct create with an explicit subscriber list (" + (clean(by("R5")) ? "flat" : "rel") + ")");
  else if (convert) console.log("\n  STRATEGY: convert fallback - create parentless, then PATCH parent_task_id");
  else console.log("\n  STRATEGY: BLOCKED - no shape kept the subscriber list clean. Do not ship a create-then-remove version.");
  if (watcherIds.length) console.log("  NOTE: this project has watchers (" + watcherIds.join(",") + "). No payload can suppress those.");
}

async function cmdRecheck() {
  requireToken();
  const all = ledgerRead();
  if (!all.length) { console.log("ledger is empty"); return; }
  console.log("Re-reading " + all.length + " probe tasks (catches delayed subscriber fan-out)");
  for (const e of all) {
    const s = await readSubscribers(e.id);
    console.log("  " + e.row.padEnd(4) + " " + e.id.padEnd(9) + " " + fmt(s.ids) + "  " + e.title);
  }
}

async function cmdCleanup() {
  requireToken();
  const all = ledgerRead();
  if (!all.length) { console.log("ledger is empty, nothing to clean up"); return; }
  if (!has("yes")) {
    console.log("Would delete " + all.length + " tasks this script created:");
    for (const e of all) console.log("  " + e.id + "  " + e.title);
    console.log("\nRe-run with --yes to delete. Nothing else is ever touched.");
    return;
  }
  // Reverse creation order, so a converted or nested child goes before whatever it hangs off.
  const remaining = [];
  for (const e of [...all].reverse()) {
    const r = await api("DELETE", "/tasks/" + e.id);
    const ok = r.status >= 200 && r.status < 300;
    console.log("  " + e.id + " -> " + r.status + (ok ? " deleted" : " KEPT: " + errorText(r).slice(0, 120)));
    if (!ok) remaining.push(e);
  }
  ledgerWrite(remaining.reverse());
  if (remaining.length) {
    console.log("\n" + remaining.length + " could not be deleted. If Productive only archives tasks,");
    console.log("say so and I will switch cleanup to a close/archive PATCH. They are still in the ledger.");
  }
}

function printHeaders() {
  if (!observedHeaders.size) return;
  console.log("\n===== R8: rate-limit-ish response headers seen =====");
  for (const [k, v] of observedHeaders) console.log("  " + k + ": " + v);
}

function requireToken() {
  if (TOKEN) return;
  console.log("PRODUCTIVE_TOKEN is not set. Run it like:");
  console.log("  PRODUCTIVE_TOKEN=xxx node scripts/phase0.mjs read --task 20251762");
  process.exit(1);
}

function usage() {
  console.log([
    "Phase 0 probe for the Productive sub-task extension.",
    "",
    "  PRODUCTIVE_TOKEN=xxx node scripts/phase0.mjs <command> [flags]",
    "",
    "Commands (the first three are read-only):",
    "  spec                         download the OpenAPI spec and print only the relevant fragments",
    "  read    --task <id>          inspect a task: shape, includes, subscribers, workflow, watchers",
    "  people                       people census: which signal identifies 4Site staff",
    "  matrix  --parent <id>        the create matrix. DRY RUN unless you add --yes",
    "  recheck                      re-read every task in the ledger, for delayed fan-out",
    "  cleanup                      delete the tasks this script created. Needs --yes",
    "",
    "Flags: --yes  --slow <ms>  --max-notifiable <n>  --force  --no-recheck  --show-names",
    "",
    "Env: PRODUCTIVE_TOKEN (required), PRODUCTIVE_ORG (default " + ORG_ID + "), PRODUCTIVE_EMAIL (default " + MY_EMAIL + ")"
  ].join("\n"));
}

const COMMANDS = {
  spec: cmdSpec,
  read: () => cmdRead(flag("task")),
  people: cmdPeople,
  matrix: cmdMatrix,
  recheck: cmdRecheck,
  cleanup: cmdCleanup,
  help: usage
};

// Only run when invoked directly. Importing this file (to exercise the pure builders without a
// network) must not fire a command.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const run = COMMANDS[cmd] || usage;
  // usage() is synchronous, so the result is wrapped rather than assumed to be a promise.
  Promise.resolve(run()).catch((e) => {
    console.error("[phase0] unhandled:", e);
    process.exit(1);
  });
}
