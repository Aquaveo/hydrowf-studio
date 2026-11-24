// A pipeline draft and the edits the editor makes to it. Every edit returns a new draft and leaves the old one
// alone. A draft is a hydrowf-core Pipeline in the making, plus what only the editor needs:
//
//   {id, version, title, description,
//    steps: [{name, tool: {id, version}, inputs: {port: Source}, formats: {output: dataId}}],
//    inputs: {name: port},                  named run inputs (kept from a published pipeline: description etc.)
//    layout: {step: {x, y}},
//    results: ["step.output", ...]}        the step outputs kept as the pipeline's outputs
//
// Source is one of hydrowf-core's four shapes: {value}, {input} (asked when the pipeline runs: `true` for a
// new one named by toPipeline, or the name of a pipeline input), {step, output} (another step's output: an
// edge), {data: {id, version}} (a registered data lego). toPipeline() turns a draft into the JSON the registry
// publishes. The rules here are hydrowf-core's (models/lego.py, registry/validate.py), so what the editor
// allows the registry takes; the registry still has the last word.
//
// `tools` maps "id@version" to a tool lego as the registry serves it; `dataLegos` is the registry's data list.

export const STEP_NAME = /^[a-z][a-z0-9-]*$/;            // StepName, also the Argo task name; at most 40
export const LEGO_ID = /^[a-z0-9][a-z0-9.-]*$/;          // LegoId; at most 63
export const SEMVER = /^\d+\.\d+\.\d+$/;                 // SemVer; at most 32
export const PORT_NAME = /^[a-z_][a-z0-9_]*$/;
export const LINKABLE_OUTPUT = ["file", "directory"];
export const DATA_PORT = ["file", "directory", "dataset"];
export const key = (ref) => `${ref.id}@${ref.version}`;
export const isLink = (src) => src != null && "step" in src;
export const isRunInput = (src) => src != null && "input" in src;

export const emptyDraft = () => ({ id: "", version: "0.1.0", title: "", description: "", steps: [], inputs: {},
                                   layout: {}, results: [] });

const semverKey = (v) => String(v).split(".").map((n) => n.padStart(10, "0")).join(".");
export const byVersion = (a, b) => (semverKey(a.version) < semverKey(b.version) ? -1 : semverKey(a.version) > semverKey(b.version) ? 1 : 0);

/** The data lego a step writes to its tool's `output`: the step's choice, else the port's first format. */
export function chosenFormat(step, port) {
  return step.formats?.[port.name] ?? port.formats?.[0] ?? port.data ?? null;
}

// ---- hydrowf-core's checks, in JavaScript

const VALUE_TYPES = { string: "string", enum: "string", int: "int", float: "number", boolean: "boolean" };

/** Why `value` can't be a constant of `port` (models/lego.py value_problem), or null. A pattern JavaScript
 *  can't compile (lookarounds aren't Rust's either, but some syntax differs) is left to the registry. */
export function valueProblem(port, value) {
  const want = VALUE_TYPES[port.type];
  if (!want) return `a ${port.type} port can't take a constant`;
  const ok = want === "string" ? typeof value === "string"
    : want === "boolean" ? typeof value === "boolean"
      : want === "int" ? Number.isSafeInteger(value) : typeof value === "number" && Number.isFinite(value);
  if (!ok && want === "int" && Number.isInteger(value)) return `${value} is too large for this page to send exactly`;
  if (!ok) return `${JSON.stringify(value)} is not a ${port.type}`;
  if (port.type === "enum" && !port.symbols.includes(value)) return `${JSON.stringify(value)} is not one of ${port.symbols.join(", ")}`;
  if (port.pattern != null) {
    let re = null;
    try { re = new RegExp(`^(?:${port.pattern})$`); } catch { /* left to the registry */ }
    if (re && (!/^[\x00-\x7f]*$/.test(value) || !re.test(value))) return `${JSON.stringify(value)} does not match ${port.pattern}`;
  }
  return null;
}

/** Why data lego `data` can't feed `port` of `tool` (registry/validate.py data_source_problem), or null. */
export function dataSourceProblem(port, data, tool) {
  if (!DATA_PORT.includes(port.type)) return `a ${port.type} port can't take a data lego`;
  if (!data) return "that data lego isn't in the registry";
  if (port.data !== data.id) return `data lego ${data.id} doesn't fit a port of ${port.data}`;
  const storage = data.storage ?? {};
  if (storage.driver === "external") {
    if (port.type !== "dataset") return `external data ${data.id} is read in place: it feeds a dataset port, not a ${port.type} port`;
    if (!tool.network) return `external data ${data.id} is read from the internet: ${tool.id} must declare network: true`;
    return null;
  }
  if (storage.driver === "stac" && storage.location != null) {
    if (port.type === "dataset") return null;
    const kind = storage.location.endsWith("/") ? "directory" : "file";
    return kind === port.type ? null : `managed data ${data.id} is a ${kind} (${storage.location}), the port wants a ${port.type}`;
  }
  if (storage.driver === "stac") return `${data.id} is output data: a run's output is passed as a link or an s3:// input, not by id`;
  if (port.type !== "dataset") return `${storage.driver} data ${data.id} is read in place: it feeds a dataset port, not a ${port.type} port`;
  return null;
}

/** The data legos `port` of `tool` can take by id, oldest version first. */
export function dataChoices(port, tool, dataLegos) {
  return dataLegos.filter((d) => d.id === port.data && !dataSourceProblem(port, d, tool)).sort(byVersion);
}

/** Why the output `from` can't feed the input `to`, ignoring what feeds `to` now (validate.py source_problem):
 *  only file and directory outputs link; a link carries the format its step chose, and fits a port of the same
 *  type and data lego, or a dataset port of that data lego, read in place unless that lego keeps outputs as one
 *  .tgz (linked_read_problem). */
export function linkFit(draft, tools, from, to, dataLegos = []) {
  const source = draft.steps.find((s) => s.name === from.step);
  const target = draft.steps.find((s) => s.name === to.step);
  if (!source || !target) return "that step doesn't exist";
  const output = tools[key(source.tool)]?.outputs.find((o) => o.name === from.output);
  const port = tools[key(target.tool)]?.inputs.find((p) => p.name === to.port);
  if (!output) return `${from.step} has no output ${from.output}`;
  if (!port) return `${to.step} has no input ${to.port}`;
  if (!LINKABLE_OUTPUT.includes(output.type)) return `${from.step}.${from.output} is a ${output.type} output`;
  const data = chosenFormat(source, output);
  if (port.type === "dataset" && data === port.data) {
    const newest = dataLegos.filter((d) => d.id === data).sort(byVersion).at(-1);
    if (newest?.storage?.driver === "stac" && newest.storage.archive === "tgz") {
      return `${from.step}.${from.output} is stored as one .tgz (${data}): a dataset port can't read it in place`;
    }
    return null;
  }
  if (output.type !== port.type || data !== port.data) {
    return `${from.step}.${from.output} is ${output.type} of ${data}; ${to.step}.${to.port} wants ` +
      `${port.type}${port.data ? ` of ${port.data}` : ""}`;
  }
  return null;
}

/** Is there a path of links from step `from` to step `to`? */
function reaches(draft, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const name = stack.pop();
    if (name === to) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const s of draft.steps) {
      if (Object.values(s.inputs).some((src) => isLink(src) && src.step === name)) stack.push(s.name);
    }
  }
  return false;
}

/** Why a new link from `from` to `to` can't be made, or null: linkFit, and no self link, no second link into
 *  one input, no cycle (Pipeline.order). */
export function linkProblem(draft, tools, from, to, dataLegos = []) {
  if (from.step === to.step) return "a step can't feed itself";
  const target = draft.steps.find((s) => s.name === to.step);
  if (target && isLink(target.inputs[to.port])) return `${to.step}.${to.port} is already linked`;
  const unfit = linkFit(draft, tools, from, to, dataLegos);
  if (unfit) return unfit;
  if (reaches(draft, to.step, from.step)) return "that link would make a cycle";
  return null;
}

/** The step outputs that could feed `to` now: "step.output" names, for choosing a link without a pointer. */
export function linkChoices(draft, tools, to, dataLegos = []) {
  const unlinked = { ...draft, steps: draft.steps.map((s) => (s.name === to.step ? { ...s, inputs: { ...s.inputs, [to.port]: null } } : s)) };
  return draft.steps.flatMap((s) => (tools[key(s.tool)]?.outputs ?? [])
    .filter((o) => !linkProblem(unlinked, tools, { step: s.name, output: o.name }, to, dataLegos))
    .map((o) => `${s.name}.${o.name}`));
}

// ---- edits

function stepName(draft, tool) {
  const base = (tool.id.replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "step").slice(0, 36);
  const taken = new Set(draft.steps.map((s) => s.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

export function addStep(draft, tool, at = { x: 40, y: 40 }) {
  const name = stepName(draft, tool);
  const step = { name, tool: { id: tool.id, version: tool.version }, inputs: {}, formats: {} };
  const results = [...draft.results, ...tool.outputs.filter((o) => LINKABLE_OUTPUT.includes(o.type))
    .map((o) => `${name}.${o.name}`)];                    // kept until something reads them
  return { draft: { ...draft, steps: [...draft.steps, step], layout: { ...draft.layout, [name]: { ...at } },
                    results }, name };
}

export function removeStep(draft, name) {
  const steps = draft.steps.filter((s) => s.name !== name).map((s) => ({
    ...s,
    inputs: Object.fromEntries(Object.entries(s.inputs).filter(([, src]) => !(isLink(src) && src.step === name))),
  }));
  const { [name]: _gone, ...layout } = draft.layout;
  return { ...draft, steps, layout, results: draft.results.filter((r) => !r.startsWith(`${name}.`)) };
}

export function moveStep(draft, name, x, y) {
  return { ...draft, layout: { ...draft.layout, [name]: { x: Math.round(x), y: Math.round(y) } } };
}

function withStep(draft, name, change) {
  return { ...draft, steps: draft.steps.map((s) => (s.name === name ? change(s) : s)) };
}

/** A step input's source; null removes it (the tool's default, if any, applies). */
export function setSource(draft, name, port, source) {
  return withStep(draft, name, (s) => {
    const inputs = { ...s.inputs };
    if (source == null) delete inputs[port];
    else inputs[port] = source;
    return { ...s, inputs };
  });
}

export function setFormat(draft, name, output, dataId) {
  return withStep(draft, name, (s) => ({ ...s, formats: { ...s.formats, [output]: dataId } }));
}

export function setResult(draft, name, output, kept) {
  const id = `${name}.${output}`;
  const results = draft.results.filter((r) => r !== id);
  return { ...draft, results: kept ? [...results, id] : results };
}

/** The draft with the link; a value or data lego set on that input is replaced. Throws with the problem. */
export function link(draft, tools, from, to, dataLegos = []) {
  const problem = linkProblem(draft, tools, from, to, dataLegos);
  if (problem) throw new Error(problem);
  const linked = setSource(draft, to.step, to.port, { step: from.step, output: from.output });
  return setResult(linked, from.step, from.output, false);     // read by the next step: no longer kept by default
}

/** Every link: {from: {step, output}, to: {step, port}}. */
export function links(draft) {
  return draft.steps.flatMap((s) => Object.entries(s.inputs)
    .filter(([, src]) => isLink(src))
    .map(([port, src]) => ({ from: { step: src.step, output: src.output }, to: { step: s.name, port } })));
}

// ---- the pipeline JSON

const PORT_FIELDS = ["type", "data", "symbols", "pattern", "optional", "default", "description"];

function portSpec(name, port) {
  const spec = { name };
  for (const f of PORT_FIELDS) {
    const v = port[f];
    const empty = v === undefined || v === null || (f === "optional" && v === false) || (f === "description" && v === "") ||
      (Array.isArray(v) && !v.length);                       // a default of false or "" is a real default: kept
    if (!empty) spec[f] = v;
  }
  return spec;
}

/** Each step input asked when the pipeline runs, with the pipeline input it reads: a named one keeps its name
 *  (and its spec, from draft.inputs when it came from a published pipeline); a new one is named after its port,
 *  or step_port when that name is taken. */
function runInputs(draft, tools) {
  const asked = [];
  for (const s of draft.steps) {
    for (const [name, src] of Object.entries(s.inputs)) {
      const port = tools[key(s.tool)]?.inputs.find((p) => p.name === name);
      if (isRunInput(src) && port) {
        const named = typeof src.input === "string" ? src.input : null;
        asked.push({ step: s.name, port, named, published: named !== null });
      }
    }
  }
  const taken = new Set([...asked.filter((a) => a.named).map((a) => a.named), ...Object.keys(draft.inputs ?? {})]);
  const fresh = asked.filter((x) => !x.named);
  const sharing = new Map();                                 // port name -> how many new inputs want it (counted first)
  for (const a of fresh) sharing.set(a.port.name, (sharing.get(a.port.name) ?? 0) + 1);
  for (const a of fresh) {
    let name = sharing.get(a.port.name) > 1 || taken.has(a.port.name) ? `${a.step.replace(/-/g, "_")}_${a.port.name}` : a.port.name;
    for (let i = 2; taken.has(name); i++) name = `${a.step.replace(/-/g, "_")}_${a.port.name}_${i}`;
    taken.add(name);
    a.named = name;
  }
  return asked;
}

/** The hydrowf-core Pipeline JSON for the registry. Run inputs become the pipeline's inputs (the tool port,
 *  without its `path`, or the published spec); kept outputs its outputs, named by the output when that is
 *  unique, else step-output. Inputs naming a port the tool doesn't have are left out (problems() says so). */
export function toPipeline(draft, tools) {
  const asked = runInputs(draft, tools);
  const specs = new Map();
  for (const a of asked) {
    if (!specs.has(a.named)) {
      specs.set(a.named, a.published && draft.inputs?.[a.named] ? { ...draft.inputs[a.named], name: a.named } : portSpec(a.named, a.port));
    }
  }
  const steps = draft.steps.map((s) => {
    const tool = tools[key(s.tool)];
    const inputs = {};
    for (const [port, src] of Object.entries(s.inputs)) {
      if (tool && !tool.inputs.some((p) => p.name === port)) continue;
      inputs[port] = isRunInput(src) ? { input: asked.find((a) => a.step === s.name && a.port.name === port)?.named ?? port } : src;
    }
    return { name: s.name, tool: { ...s.tool }, inputs, ...(Object.keys(s.formats ?? {}).length ? { formats: { ...s.formats } } : {}) };
  });
  const outputs = {};
  for (const r of draft.results) {
    const [step, output] = r.split(".");
    const name = draft.results.filter((x) => x.split(".")[1] === output).length > 1 ? `${step}-${output}` : output;
    outputs[name] = { step, output };
  }
  return { kind: "pipeline", id: draft.id, version: draft.version, title: draft.title,
           description: draft.description, visibility: "owner", inputs: [...specs.values()], steps, outputs };
}

/** A published pipeline opened as a draft: its inputs keep their names and specs, its outputs stay kept. */
export function fromPipeline(pipeline) {
  const steps = pipeline.steps.map((s) => ({
    name: s.name, tool: { ...s.tool }, formats: { ...(s.formats ?? {}) },
    inputs: Object.fromEntries(Object.entries(s.inputs ?? {}).map(([port, src]) => [port, { ...src }])),
  }));
  const inputs = Object.fromEntries((pipeline.inputs ?? []).map((p) => [p.name, { ...p }]));
  const results = Object.values(pipeline.outputs ?? {}).map((l) => `${l.step}.${l.output}`);
  return arrange({ id: pipeline.id, version: pipeline.version, title: pipeline.title ?? "",
                   description: pipeline.description ?? "", steps, inputs, layout: {}, results });
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SCALAR = (v) => ["string", "number", "boolean"].includes(typeof v);

/** Whether `src` is one of hydrowf-core's four Source shapes (extra keys are refused there, so here too). */
export function isSource(src) {
  if (!isObject(src)) return false;
  const keys = Object.keys(src).sort().join(",");
  if (keys === "value") return SCALAR(src.value);
  if (keys === "input") return src.input === true || (typeof src.input === "string" && PORT_NAME.test(src.input));
  if (keys === "output,step") return typeof src.step === "string" && typeof src.output === "string";
  if (keys === "data") return isObject(src.data) && typeof src.data.id === "string" && typeof src.data.version === "string";
  return false;
}

/** A draft as it is stored or imported, checked and completed; throws Error when it isn't one. */
export function normalizeDraft(raw) {
  if (!isObject(raw) || !Array.isArray(raw.steps)) throw new Error("not a draft");
  const text = (v) => (typeof v === "string" ? v : "");
  const steps = raw.steps.map((s) => {
    if (!isObject(s) || typeof s.name !== "string" || !isObject(s.tool) || typeof s.tool.id !== "string" ||
        typeof s.tool.version !== "string") throw new Error("a step needs a name and a tool");
    const inputs = isObject(s.inputs) ? Object.fromEntries(Object.entries(s.inputs).filter(([, v]) => isSource(v))) : {};
    return { name: s.name, tool: { id: s.tool.id, version: s.tool.version }, inputs,
             formats: isObject(s.formats) ? { ...s.formats } : {} };
  });
  const layout = {};
  for (const s of steps) {
    const at = isObject(raw.layout) ? raw.layout[s.name] : null;
    layout[s.name] = isObject(at) && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : { x: 40, y: 40 };
  }
  const results = Array.isArray(raw.results) ? raw.results.filter((r) => typeof r === "string" && r.includes(".")) : [];
  return { id: text(raw.id), version: text(raw.version) || "0.1.0", title: text(raw.title), description: text(raw.description),
           steps, inputs: isObject(raw.inputs) ? raw.inputs : {}, layout, results };
}

/** What the registry would refuse that the editor can see: hints before publishing. */
export function problems(draft, tools, dataLegos = []) {
  const found = [];
  if (!LEGO_ID.test(draft.id) || draft.id.length > 63) found.push("the pipeline needs an id: lowercase letters, digits, . and -, at most 63");
  if (!SEMVER.test(draft.version) || draft.version.length > 32) found.push("the version is three numbers, like 0.1.0");
  if (!draft.title.trim()) found.push("the pipeline needs a title");
  if (draft.title.length > 200) found.push("the title is at most 200 characters");
  if (draft.description.length > 10000) found.push("the description is at most 10000 characters");
  if (!draft.steps.length) found.push("add at least one step");
  const dataByKey = new Map(dataLegos.map((d) => [key(d), d]));
  const names = draft.steps.map((s) => s.name);
  for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) found.push(`step name ${name} is used twice`);
  for (const s of draft.steps) {
    const tool = tools[key(s.tool)];
    if (!tool) { found.push(`${s.name}: tool ${key(s.tool)} isn't in the registry`); continue; }
    if (!STEP_NAME.test(s.name) || s.name.length > 40) found.push(`${s.name}: a step name is lowercase letters, digits and -, at most 40`);
    const ports = new Map(tool.inputs.map((p) => [p.name, p]));
    for (const name of Object.keys(s.inputs)) if (!ports.has(name)) found.push(`${s.name}: ${tool.id} has no input ${name}`);
    for (const port of tool.inputs) {
      const src = s.inputs[port.name];
      if (src == null) {
        if (!port.optional && port.default == null) found.push(`${s.name}: ${port.name} is required`);
      } else if ("value" in src) {
        const problem = valueProblem(port, src.value);
        if (problem) found.push(`${s.name}.${port.name}: ${problem}`);
      } else if ("data" in src) {
        const problem = dataSourceProblem(port, dataByKey.get(key(src.data)), tool);
        if (problem) found.push(`${s.name}.${port.name}: ${problem}`);
      } else if (isLink(src)) {
        const problem = linkFit(draft, tools, { step: src.step, output: src.output }, { step: s.name, port: port.name }, dataLegos);
        if (problem) found.push(`${s.name}.${port.name}: ${problem}`);
      }
    }
    for (const [output, data] of Object.entries(s.formats ?? {})) {
      const port = tool.outputs.find((o) => o.name === output);
      if (!port?.formats?.includes(data)) found.push(`${s.name}: ${output} can't be written as ${data}`);
    }
  }
  return found;
}

/** Columns by longest path from a step with no links in; the draft's order within a column. */
export function arrange(draft, height = () => 140, { left = 40, top = 40, columnGap = 300, rowGap = 40 } = {}) {
  const column = new Map();
  const depth = (name, trail = new Set()) => {
    if (column.has(name)) return column.get(name);
    if (trail.has(name)) return 0;                       // a cycle: the registry refuses it; don't loop here
    trail.add(name);
    const step = draft.steps.find((s) => s.name === name);
    const sources = Object.values(step?.inputs ?? {}).filter(isLink).map((src) => src.step);
    const d = sources.length ? 1 + Math.max(...sources.map((src) => depth(src, trail))) : 0;
    column.set(name, d);
    return d;
  };
  const bottoms = new Map();
  const layout = {};
  for (const s of draft.steps) {
    const c = depth(s.name);
    const y = bottoms.get(c) ?? top;
    bottoms.set(c, y + height(s) + rowGap);
    layout[s.name] = { x: left + c * columnGap, y };
  }
  return { ...draft, layout };
}
