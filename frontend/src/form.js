// A step's panel: where each tool input gets its value, and what happens to each output.
// fieldsFor/outputsFor/parseValue are pure (tested); renderStep draws them.
import { DATA_PORT, LINKABLE_OUTPUT, chosenFormat, dataChoices, isLink, isRunInput, valueProblem } from "./pipeline.js";

const SCALARS = ["string", "int", "float", "boolean", "enum"];

/** The mode of a source: linked (an edge), run (asked when the pipeline runs), data, value, or unset. */
export function modeOf(src) {
  if (src == null) return "unset";
  if (isLink(src)) return "linked";
  if (isRunInput(src)) return "run";
  if ("data" in src) return "data";
  return "value";
}

/** One field per tool input: its port, its current source, and the modes it can take. `dataLegos`: the
 *  registry's data legos (a port is offered those it can take by id); `linkChoices(port)`: the step outputs
 *  that could feed it ("step.output"), so a link can be made without a pointer. */
export function fieldsFor(step, tool, dataLegos = [], linkChoices = () => []) {
  return tool.inputs.map((port) => {
    const src = step.inputs[port.name];
    const data = DATA_PORT.includes(port.type) ? dataChoices(port, tool, dataLegos) : [];
    const links = DATA_PORT.includes(port.type) ? linkChoices(port) : [];
    const mode = modeOf(src);
    const modes = ["unset", ...(SCALARS.includes(port.type) ? ["value"] : []), "run", ...(data.length || mode === "data" ? ["data"] : []),
                   ...(links.length || mode === "linked" ? ["linked"] : [])];
    return {
      name: port.name, port, mode, src, modes, dataChoices: data, linkChoices: links,
      required: !port.optional && port.default == null,
      linkedFrom: isLink(src) ? `${src.step}.${src.output}` : null,
      problem: mode === "value" ? valueProblem(port, src.value) : null,
    };
  });
}

export function outputsFor(step, tool, draft) {
  return tool.outputs.map((port) => ({
    name: port.name, port, linkable: LINKABLE_OUTPUT.includes(port.type),
    formats: port.formats ?? [], chosen: chosenFormat(step, port),
    kept: draft.results.includes(`${step.name}.${port.name}`),
  }));
}

/** {value} for what was typed into a scalar port's field (typed as the port says), or {value, problem} when
 *  hydrowf-core's value_problem would refuse it: the value is kept, and problems() blocks publishing. */
export function parseValue(port, raw) {
  let value;
  if (port.type === "boolean") value = raw === true || raw === "true";
  else {
    const text = String(raw ?? "").trim();
    if (port.type === "int") value = /^-?\d+$/.test(text) ? Number(text) : text;
    else if (port.type === "float") value = text !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
    else value = text;
  }
  const problem = valueProblem(port, value);
  return problem ? { value, problem } : { value };
}

/** Why a run dialog field won't do (/ogc checks again), or null. `field`: {name, type (the input element's),
 *  kind (the schema type), value, required, badInput (the browser couldn't read a number), pattern}. A checkbox
 *  always has a value: true or false. */
export function runProblem(field) {
  if (field.type === "checkbox") return null;
  if (field.badInput) return `${field.name} is a number`;
  const value = String(field.value ?? "").trim();
  if (value === "") return field.required ? `${field.name} is required` : null;
  if (field.type === "number" && !Number.isFinite(Number(value))) return `${field.name} is a number`;
  if (field.kind === "integer" && !/^-?\d+$/.test(value)) return `${field.name} is a whole number`;
  if (field.kind === "integer" && !Number.isSafeInteger(Number(value))) return `${field.name} is too large for this page to send exactly`;
  if (field.pattern) {
    let re = null;
    try { re = new RegExp(`^(?:${field.pattern.replace(/^\^/, "").replace(/\$$/, "")})$`); } catch { /* /ogc checks */ }
    if (re && (!/^[\x00-\x7f]*$/.test(value) || !re.test(value))) return `${field.name} doesn't match ${field.pattern}`;
  }
  return null;
}

// ---- drawing

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

const MODE_LABEL = { unset: "default", value: "value", run: "ask when running", data: "data", linked: "linked" };

function valueControl(field, readOnly, onSource) {
  const { port, src } = field;
  const label = `${field.name} value`;
  let control;
  if (port.type === "boolean") {
    control = el("input", { type: "checkbox", disabled: readOnly, "aria-label": label });
    control.checked = src?.value === true;
    control.addEventListener("change", () => onSource(parseValue(port, control.checked)));
  } else if (port.type === "enum") {
    control = el("select", { disabled: readOnly, "aria-label": label }, ...port.symbols.map((s) => el("option", { value: s }, s)));
    control.value = String(src?.value ?? port.symbols[0]);
    control.addEventListener("change", () => onSource(parseValue(port, control.value)));
  } else {
    control = el("input", { type: "text", spellcheck: "false", disabled: readOnly, "aria-label": label,
                            placeholder: port.default != null ? String(port.default) : "" });
    control.value = String(src?.value ?? "");
    control.addEventListener("change", () => onSource(parseValue(port, control.value)));
  }
  return [control, el("small", { class: "field-problem" }, field.problem ?? "")];
}

function choiceControl(label, options, current, readOnly, onPick) {
  const control = el("select", { disabled: readOnly, "aria-label": label },
                     ...options.map(([value, text]) => el("option", { value }, text)));
  if (current) control.value = current;
  control.addEventListener("change", () => onPick(control.value));
  return control;
}

/** The panel for one step. Callbacks: onSource(port, source|null), onFormat(output, dataId),
 *  onResult(output, kept), onRemove(). */
export function renderStep(container, { step, tool, draft, dataLegos, linkChoices, readOnly, onSource, onFormat, onResult, onRemove }) {
  container.replaceChildren();
  container.append(el("h3", {}, step.name),
                   el("p", { class: "muted" }, `${tool.title || tool.id} · ${tool.id}@${tool.version}`));
  if (tool.description) container.append(el("p", { class: "muted small" }, tool.description));

  container.append(el("h4", {}, "Inputs"));
  for (const field of fieldsFor(step, tool, dataLegos, linkChoices)) {
    const { port } = field;
    const title = el("span", { class: "field-title", title: port.description || "" },
                     port.name, field.required ? " *" : "",
                     el("small", { class: "muted" }, ` ${port.type}${port.data ? ` of ${port.data}` : ""}`));
    const row = el("div", { class: "field", role: "group", "aria-label": port.name }, title);
    const mode = el("select", { class: "mode", disabled: readOnly, "aria-label": `${port.name} source` },
                    ...field.modes.map((m) => el("option", { value: m }, MODE_LABEL[m])));
    mode.value = field.mode;
    mode.addEventListener("change", () => {
      if (mode.value === "unset") onSource(port.name, null);
      else if (mode.value === "run") onSource(port.name, { input: true });
      else if (mode.value === "data") {
        const d = field.dataChoices.at(-1);                        // the newest version
        onSource(port.name, { data: { id: d.id, version: d.version } });
      } else if (mode.value === "linked") {
        const [stepName, output] = field.linkChoices[0].split(".");
        onSource(port.name, { step: stepName, output });
      } else {
        const start = port.default ?? (port.type === "enum" ? port.symbols[0] : port.type === "boolean" ? false : "");
        onSource(port.name, { value: parseValue(port, start).value });
      }
    });
    row.append(mode);
    if (field.mode === "value") row.append(...valueControl(field, readOnly, (parsed) => onSource(port.name, { value: parsed.value })));
    if (field.mode === "data") {
      const current = field.src.data ? `${field.src.data.id}@${field.src.data.version}` : "";
      row.append(choiceControl(`${port.name} data lego`, field.dataChoices.map((d) => [`${d.id}@${d.version}`, `${d.title || d.id} ${d.version}`]),
                               current, readOnly, (picked) => {
        const [id, version] = picked.split("@");
        onSource(port.name, { data: { id, version } });
      }));
    }
    if (field.mode === "linked") {
      const options = [...new Set([field.linkedFrom, ...field.linkChoices])].map((c) => [c, `from ${c}`]);
      row.append(choiceControl(`${port.name} linked from`, options, field.linkedFrom, readOnly, (picked) => {
        const [stepName, output] = picked.split(".");
        onSource(port.name, { step: stepName, output });
      }));
    }
    if (field.mode === "run" && typeof field.src.input === "string") row.append(el("small", { class: "muted" }, `as ${field.src.input}`));
    if (field.mode === "unset" && field.required) row.append(el("small", { class: "field-problem" }, "required"));
    container.append(row);
  }

  container.append(el("h4", {}, "Outputs"));
  for (const out of outputsFor(step, tool, draft)) {
    const row = el("div", { class: "field", role: "group", "aria-label": out.name },
                   el("span", { class: "field-title" }, out.name, el("small", { class: "muted" }, ` ${out.port.type}`)));
    if (out.formats.length) {
      row.append(choiceControl(`${out.name} format`, out.formats.map((f) => [f, f]), out.chosen, readOnly,
                               (picked) => onFormat(out.name, picked)));
    } else if (out.chosen) {
      row.append(el("small", { class: "muted" }, out.chosen));
    }
    if (out.linkable) {
      const keep = el("input", { type: "checkbox", disabled: readOnly });
      keep.checked = out.kept;
      keep.addEventListener("change", () => onResult(out.name, keep.checked));
      row.append(el("label", { class: "keep" }, keep, " keep as a result"));
    }
    container.append(row);
  }
  if (!readOnly) container.append(el("button", { class: "danger", onclick: onRemove }, "Remove step"));
}
