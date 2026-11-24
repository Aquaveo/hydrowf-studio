// The studio page: a pipeline draft in the editor, published to the registry and run on /ogc as the user.
// Drafts live in this browser (localStorage), with export and import as JSON files; everything else lives in
// the services. While a job is shown, its steps are read every poll-seconds; nothing here runs a pipeline.
import { Api, ApiError, newest } from "./api.js";
import { Editor, heightOf } from "./editor.js";
import { renderStep, runProblem } from "./form.js";
import * as P from "./pipeline.js";

const root = document.getElementById("root");
const api = new Api(root.dataset.api);
const POLL_MS = Math.max(2, Number(root.dataset.pollSeconds) || 10) * 1000;
const STORE = "hydrowf-studio.drafts";
const ACTIVE = ["accepted", "running"];
const $ = (id) => document.getElementById(id);

const state = {
  tools: {},                 // "id@version" -> tool lego (every version the user may see)
  dataLegos: [],
  pipelines: [],             // the newest version of each pipeline the user may see: templates
  drafts: load(),            // key -> draft
  current: null,             // the open draft's key
  selected: null,
  job: null,                 // {id, generation, record, steps, results}: the job shown
};
let pollTimer = null;
let generation = 0;          // which job view a poll belongs to: a late answer for an older one is dropped

/** The stored drafts that still read as drafts; the rest are dropped, so one bad draft can't stop the page. */
function load() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
  const drafts = {};
  for (const [key, raw] of Object.entries(stored && typeof stored === "object" ? stored : {})) {
    try { drafts[key] = P.normalizeDraft(raw); } catch { /* dropped */ }
  }
  return drafts;
}

function store() {
  try { localStorage.setItem(STORE, JSON.stringify(state.drafts)); } catch { say("this browser won't keep drafts: export them"); }
}

const draft = () => state.drafts[state.current];

// ---- messages

function say(text, kind = "info") {
  const bar = $("messages");
  bar.textContent = text;
  bar.className = `messages ${kind}`;
}

function answered() {
  $("login").hidden = true;                                   // a call went through: the login is fine again
}

/** Show what went wrong. A failure that isn't the API's is a bug: logged, and the user told something did. */
function failed(err, where = say) {
  if (!(err instanceof ApiError)) {
    console.error(err);
    where("something went wrong in the page; reload it, your drafts are kept", "error");
    return;
  }
  if (err.login && err.login.startsWith("/") && !err.login.startsWith("//")) {
    $("login").hidden = false;
    $("login-link").href = err.login;
  }
  where(err.outcome === "unknown" ? `${err.message} — look in Jobs before trying again` : err.message, "error");
}

// ---- the editor and the side panel

const editor = new Editor($("canvas"), {
  onChange: (d) => update(d, false),
  onSelect: (selection) => { state.selected = selection; panel(); },
  onProblem: (text) => say(text, "error"),
});

function update(next, redraw = true) {
  state.drafts[state.current] = next;
  store();
  draftList();
  if (redraw) show();
  else panel();
}

/** A job's step statuses, shown on the draft only when the job ran these very steps (a job names its
 *  pipeline by id, not version: another version's steps may differ). */
function statusesFor(d) {
  const job = state.job;
  if (!job || job.record?.processID !== d.id) return {};
  const names = Object.keys(job.steps ?? {});
  const mine = d.steps.map((s) => s.name);
  return names.length === mine.length && names.every((n) => mine.includes(n)) ? job.steps : {};
}

function canvas() {
  const d = draft();
  editor.show(d, state.tools, { dataLegos: state.dataLegos, statuses: statusesFor(d) });
  $("draft-name").textContent = d.title || d.id || "untitled";
}

function show() {
  canvas();
  panel();
}

function panel() {
  const d = draft();
  const box = $("panel");
  const step = state.selected?.kind === "step" ? d.steps.find((s) => s.name === state.selected.id) : null;
  if (step && state.tools[P.key(step.tool)]) {
    renderStep(box, {
      step, tool: state.tools[P.key(step.tool)], draft: d, dataLegos: state.dataLegos, readOnly: false,
      linkChoices: (port) => P.linkChoices(d, state.tools, { step: step.name, port: port.name }, state.dataLegos),
      onSource: (port, src) => {
        try {
          if (src && P.isLink(src)) update(P.link(P.setSource(d, step.name, port, null), state.tools, src, { step: step.name, port }, state.dataLegos));
          else update(P.setSource(d, step.name, port, src));
        } catch (err) { say(err.message, "error"); }
      },
      onFormat: (output, data) => update(P.setFormat(d, step.name, output, data)),
      onResult: (output, kept) => update(P.setResult(d, step.name, output, kept)),
      onRemove: () => { state.selected = null; update(P.removeStep(d, step.name)); },
    });
    return;
  }
  box.replaceChildren(settingsForm(d));
}

function settingsForm(d) {
  const form = document.createElement("div");
  form.innerHTML = `<h3>Pipeline</h3>
    <label class="field"><span class="field-title">id</span><input name="id" spellcheck="false" placeholder="my-pipeline"></label>
    <label class="field"><span class="field-title">version</span><input name="version" spellcheck="false"></label>
    <label class="field"><span class="field-title">title</span><input name="title"></label>
    <label class="field"><span class="field-title">description</span><textarea name="description" rows="3"></textarea></label>
    <h4>Before publishing</h4><ul class="problems"></ul>
    <p class="muted small">Select a step (click it, or Tab to it and press Enter) to set its inputs. Drag from an
    output (right) to an input (left) to link steps, or pick "linked" in an input's panel; Delete removes the
    selected step or link.</p>`;
  for (const name of ["id", "version", "title", "description"]) {
    const input = form.querySelector(`[name=${name}]`);
    input.value = d[name] ?? "";
    input.addEventListener("change", () => update({ ...draft(), [name]: input.value.trim() }));
  }
  const problems = P.problems(d, state.tools, state.dataLegos);
  form.querySelector(".problems").append(...(problems.length ? problems : ["nothing: ready to publish"]).map((p) => {
    const li = document.createElement("li");
    li.textContent = p;
    return li;
  }));
  return form;
}

// ---- drafts

function newDraft(d = P.emptyDraft()) {
  const key = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  state.drafts[key] = d;
  open(key);
}

function open(key) {
  state.current = key;
  state.selected = null;
  editor.select(null);
  store();
  draftList();
  show();
}

function draftList() {
  const pick = $("drafts");
  pick.replaceChildren(...Object.entries(state.drafts).map(([key, d]) => new Option(d.title || d.id || "untitled", key)));
  pick.value = state.current;
}

function palette() {
  const filter = $("tool-filter").value.trim().toLowerCase();
  const tools = newest(Object.values(state.tools)).filter((t) => `${t.id} ${t.title}`.toLowerCase().includes(filter));
  $("tools").replaceChildren(...tools.map((tool) => {
    const item = document.createElement("button");
    item.className = "tool";
    item.title = tool.description || "";
    item.innerHTML = `<strong></strong><small></small>`;
    item.querySelector("strong").textContent = tool.title || tool.id;
    item.querySelector("small").textContent = `${tool.id}@${tool.version}`;
    item.addEventListener("click", () => {
      const added = P.addStep(draft(), tool, editor.centre());
      update(added.draft);
      editor.select({ kind: "step", id: added.name });
    });
    return item;
  }));
  $("templates").replaceChildren(new Option("Start from a pipeline…", ""),
    ...state.pipelines.map((p) => new Option(`${p.title || p.id} (${p.id}@${p.version})`, P.key(p))));
}

// ---- publish and run

async function publish() {
  const d = draft();
  const problems = P.problems(d, state.tools, state.dataLegos);
  if (problems.length) return say(`not yet: ${problems[0]}`, "error");
  try {
    const stored = await api.publish(P.toPipeline(d, state.tools));
    answered();
    say(`published ${stored.id}@${stored.version}: it can run within a minute (bump the version to publish changes)`);
    refreshCatalogue();
  } catch (err) { failed(err); }
}

async function openRun() {
  const d = draft();
  const id = `${d.id}@${d.version}`;
  let description;
  try { description = await api.process(id); } catch (err) {
    if (err instanceof ApiError && err.status === 404) return say(`${id} isn't published yet (or was published under a minute ago)`, "error");
    return failed(err);
  }
  answered();
  const fields = $("run-fields");
  const error = $("run-error");
  error.textContent = "";
  fields.replaceChildren(...Object.entries(description.inputs ?? {}).map(([name, input]) => runField(name, input)));
  $("run-title").textContent = `Run ${id}`;
  $("run-form").onsubmit = async (event) => {
    event.preventDefault();
    const start = $("run-start");
    const inputs = {};
    for (const control of fields.querySelectorAll("[data-input]")) {
      const problem = runProblem({ name: control.dataset.input, type: control.type, kind: control.dataset.kind,
                                   value: control.value, required: control.dataset.required === "true",
                                   badInput: control.validity?.badInput, pattern: control.dataset.pattern });
      if (problem) { error.textContent = problem; control.focus(); return; }
      const value = control.type === "checkbox" ? control.checked : control.value.trim();
      if (value === "") continue;
      inputs[control.dataset.input] = control.type === "number" ? Number(value) : value;
    }
    start.disabled = true;                                    // one run per click
    try {
      const started = await api.run(id, inputs);
      answered();
      $("run-dialog").close();
      say(`started job ${started.jobID}`);
      await listJobs();
      showJob(started.jobID);
    } catch (err) {
      failed(err, (text) => { error.textContent = text; });
    } finally {
      start.disabled = false;
    }
  };
  $("run-dialog").showModal();
}

function runField(name, input) {
  const schema = input.schema ?? {};
  const required = (input.minOccurs ?? 1) >= 1 && schema.default == null;
  const label = document.createElement("label");
  label.className = "field";
  const title = document.createElement("span");
  title.className = "field-title";
  title.textContent = `${input.title || name}${required ? " *" : ""}`;
  title.title = input.description ?? "";
  let control;
  if (Array.isArray(schema.enum)) {
    control = document.createElement("select");
    control.append(new Option(schema.default != null ? `(default: ${schema.default})` : "", ""),
                   ...schema.enum.map((v) => new Option(v, v)));
  } else if (schema.type === "boolean") {
    control = document.createElement("input");
    control.type = "checkbox";
    control.checked = schema.default === true;
  } else {
    control = document.createElement("input");
    if (schema.type === "integer" || schema.type === "number") control.type = "number";
    if (schema.type === "number") control.step = "any";
    control.placeholder = schema.default != null ? String(schema.default) : schema.format === "uri" ? "s3://bucket/key" : "";
  }
  Object.assign(control.dataset, { input: name, kind: schema.type ?? "string", required: String(required),
                                   ...(schema.pattern ? { pattern: schema.pattern } : {}) });
  label.append(title, control);
  return label;
}

// ---- jobs

async function listJobs() {
  try {
    const jobs = await api.jobs();
    answered();
    $("jobs").replaceChildren(...jobs.map((job) => {
      const item = document.createElement("button");
      item.className = `job status-${job.status}`;
      item.innerHTML = "<strong></strong><small></small>";
      item.querySelector("strong").textContent = job.processID ?? job.jobID;
      item.querySelector("small").textContent = `${job.status} · ${String(job.created ?? "").replace("T", " ").slice(0, 16)}`;
      item.addEventListener("click", () => showJob(job.jobID));
      return item;
    }));
  } catch (err) { failed(err); }
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
  generation += 1;                                          // answers still on their way are for an old view
}

function closeJob() {
  stopPolling();
  state.job = null;
  $("job").replaceChildren();
  canvas();
}

async function showJob(id) {
  stopPolling();
  state.job = { id, generation, record: null, steps: {}, results: null };
  await pollJob(state.job);
}

async function pollJob(job) {
  const current = () => state.job === job && job.generation === generation;
  try {
    const record = await api.job(job.id);
    if (!current()) return;
    const steps = (await api.steps(job.id)).steps ?? {};
    if (!current()) return;
    let results = job.results;
    if (record.status === "successful" && !results) {
      results = await api.results(job.id);
      if (!current()) return;
    }
    Object.assign(job, { record, steps, results });
    answered();
  } catch (err) {
    if (!current()) return;
    if (err instanceof ApiError && err.status === 404) { closeJob(); say(`job ${job.id} is gone`); listJobs(); return; }
    failed(err);
  }
  jobPanel();
  canvas();                                                 // the statuses only: the side panel keeps what's typed
  if (ACTIVE.includes(job.record?.status)) pollTimer = setTimeout(() => pollJob(job), POLL_MS);
  else listJobs();
}

function jobPanel() {
  const job = state.job;
  const box = $("job");
  box.replaceChildren();
  if (!job?.record) return;
  const head = document.createElement("div");
  head.innerHTML = "<h4></h4><p class='muted small'></p><ul class='steps'></ul>";
  head.querySelector("h4").textContent = `${job.record.processID} · ${job.record.status}`;
  head.querySelector("p").textContent = job.record.message || job.id;
  head.querySelector("ul").append(...Object.entries(job.steps).map(([step, status]) => {
    const li = document.createElement("li");
    li.className = `status-${status}`;
    li.textContent = `${step}: ${status}`;
    return li;
  }));
  box.append(head);
  if (job.results) box.append(resultList(job.results));
  const dismiss = document.createElement("button");
  dismiss.className = "danger";
  dismiss.textContent = ACTIVE.includes(job.record.status) ? "Stop and delete" : "Delete job and outputs";
  dismiss.addEventListener("click", async () => {
    if (!confirm(`Delete job ${job.id} and its outputs?`)) return;
    stopPolling();
    try {
      await api.dismiss(job.id);
      answered();
      if (state.job === job) closeJob();
      say(`job ${job.id} deleted`);
      listJobs();
    } catch (err) {
      failed(err);
      if (state.job === job) showJob(job.id);              // still there: keep following it
    }
  });
  box.append(dismiss);
}

function resultList(results) {
  const list = document.createElement("ul");
  list.className = "results";
  for (const [name, link] of Object.entries(results)) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = name;
    item.append(title, " ");
    if (typeof link?.href === "string" && /^https?:\/\//.test(link.href)) {
      const a = document.createElement("a");
      a.href = link.href;
      a.textContent = "download";
      a.rel = "noopener noreferrer";
      item.append(a, " ");
    }
    const address = document.createElement("code");
    address.textContent = link?.s3 ?? link?.href ?? "";
    item.append(address);
    if (Array.isArray(link?.files) && link.files.length) item.append(` (${link.files.length} files${link.truncated ? "+" : ""})`);
    list.append(item);
  }
  return list;
}

// ---- import, export, startup

function exportDraft() {
  const d = draft();
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${d.id || "draft"}-${d.version}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);      // after the download has started
}

async function importDraft(file) {
  let d;
  try {
    const parsed = JSON.parse(await file.text());
    d = P.normalizeDraft(parsed?.kind === "pipeline" ? P.fromPipeline(parsed) : parsed);   // checked before it's kept
  } catch {
    return say(`${file.name} isn't a draft or a pipeline`, "error");
  }
  newDraft(d);
  say(`imported ${file.name}`);
}

async function refreshCatalogue() {
  try {
    const [tools, dataLegos, pipelines] = await Promise.all([api.tools(), api.dataLegos(), api.pipelines()]);
    answered();
    state.tools = Object.fromEntries(tools.map((t) => [P.key(t), t]));
    state.dataLegos = dataLegos;
    state.pipelines = newest(pipelines);
    palette();
    show();
  } catch (err) { failed(err); }
}

function deleting() {
  const active = document.activeElement;
  return !active || active === document.body || $("canvas").contains(active);
}

function wire() {
  $("drafts").addEventListener("change", (e) => open(e.target.value));
  $("new").addEventListener("click", () => newDraft());
  $("arrange").addEventListener("click", () => update(P.arrange(draft(), (s) => heightOf(s, state.tools))));
  $("publish").addEventListener("click", publish);
  $("run").addEventListener("click", openRun);
  $("export").addEventListener("click", exportDraft);
  $("import").addEventListener("change", (e) => { if (e.target.files[0]) importDraft(e.target.files[0]); e.target.value = ""; });
  $("tool-filter").addEventListener("input", palette);
  $("refresh-jobs").addEventListener("click", listJobs);
  $("run-cancel").addEventListener("click", () => $("run-dialog").close());
  $("delete-draft").addEventListener("click", () => {
    if (!confirm("Delete this draft from this browser?")) return;
    delete state.drafts[state.current];
    const keys = Object.keys(state.drafts);
    if (keys.length) open(keys[0]); else newDraft();
  });
  $("templates").addEventListener("change", (e) => {
    const p = state.pipelines.find((x) => P.key(x) === e.target.value);
    e.target.value = "";
    if (!p) return;
    const d = P.arrange(P.fromPipeline(p), (s) => heightOf(s, state.tools));
    newDraft({ ...d, id: "", version: "0.1.0", title: `Copy of ${p.title || p.id}` });   // its id is its owner's
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected && deleting() && !$("run-dialog").open) {
      e.preventDefault();
      const what = state.selected.kind === "step" ? `step ${state.selected.id}` : "this link";
      if (confirm(`Remove ${what}?`)) editor.deleteSelected();
    }
  });
}

wire();
if (!Object.keys(state.drafts).length) newDraft(); else open(Object.keys(state.drafts)[0]);
refreshCatalogue();
listJobs();
