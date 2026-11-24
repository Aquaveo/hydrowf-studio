// The SVG canvas: a draft's steps, with the tool's linkable inputs on the left (file, directory, dataset ports)
// and its linkable outputs on the right (file and directory), and the links between them. It holds a draft,
// redraws it on every change, and reports changes through onChange; pipeline.js makes the edits.
import * as P from "./pipeline.js";

const NS = "http://www.w3.org/2000/svg";
export const WIDTH = 240;
const HEAD = 34;
const ROW = 22;

/** The ports a step draws, from its tool: inputs and outputs that can take or give a link. */
export function portsOf(step, tools) {
  const tool = tools[P.key(step.tool)];
  return {
    inputs: (tool?.inputs ?? []).filter((p) => P.DATA_PORT.includes(p.type)).map((p) => p.name),
    outputs: (tool?.outputs ?? []).filter((p) => P.LINKABLE_OUTPUT.includes(p.type)).map((p) => p.name),
  };
}

export function heightOf(step, tools) {
  const { inputs, outputs } = portsOf(step, tools);
  return HEAD + Math.max(1, inputs.length, outputs.length) * ROW + 8;
}

const linkKey = (l) => `${l.from.step}.${l.from.output}->${l.to.step}.${l.to.port}`;
const portY = (at, index) => at.y + HEAD + index * ROW + ROW / 2;

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

function curve(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

export class Editor {
  constructor(svg, { onChange = () => {}, onSelect = () => {}, onProblem = () => {} } = {}) {
    Object.assign(this, { svg, onChange, onSelect, onProblem });
    this.draft = P.emptyDraft();
    this.tools = {};
    this.dataLegos = [];
    this.statuses = {};                        // step -> a job's step status, while one is shown
    this.readOnly = false;
    this.selected = null;                      // {kind: "step"|"link", id}
    this.view = { x: 0, y: 0, k: 1 };
    this.drag = null;
    this.viewport = el("g", { class: "viewport" }, svg);
    this.linkLayer = el("g", { class: "links" }, this.viewport);
    this.stepLayer = el("g", { class: "steps" }, this.viewport);
    this.overlay = el("g", { class: "overlay" }, this.viewport);
    svg.addEventListener("pointerdown", (e) => this.pointerDown(e));
    svg.addEventListener("pointermove", (e) => this.pointerMove(e));
    svg.addEventListener("pointerup", (e) => this.pointerUp(e));
    svg.addEventListener("pointercancel", () => this.cancelDrag());
    svg.addEventListener("lostpointercapture", () => this.cancelDrag());
    svg.addEventListener("wheel", (e) => this.zoom(e), { passive: false });
    svg.addEventListener("keydown", (e) => {                    // a step is a button: Enter or Space selects it
      const stepHit = e.target.closest?.("[data-step].node");
      if (stepHit && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        this.focusAfter = stepHit.dataset.step;
        this.select({ kind: "step", id: stepHit.dataset.step });
      }
    });
  }

  show(draft, tools, { dataLegos = this.dataLegos, statuses = {}, readOnly = false } = {}) {
    Object.assign(this, { draft, tools, dataLegos, statuses, readOnly });
    if (this.selected && !this.exists(this.selected)) this.select(null);
    this.render();
  }

  exists({ kind, id }) {
    return kind === "step" ? this.draft.steps.some((s) => s.name === id) : P.links(this.draft).some((l) => linkKey(l) === id);
  }

  select(selection) {
    this.selected = selection;
    this.onSelect(selection);
    this.render();
  }

  change(draft) {
    this.draft = draft;
    this.render();
    this.onChange(draft);
  }

  /** Where a new step goes: the middle of what's on screen. */
  centre() {
    const r = this.svg.getBoundingClientRect();
    return this.toGraph(r.left + r.width / 2 - WIDTH / 2, r.top + r.height / 3);
  }

  toGraph(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.k, y: (clientY - r.top - this.view.y) / this.view.k };
  }

  deleteSelected() {
    if (this.readOnly || !this.selected) return;
    const { kind, id } = this.selected;
    this.selected = null;
    this.onSelect(null);
    if (kind === "step") {
      this.change(P.removeStep(this.draft, id));
    } else {
      const found = P.links(this.draft).find((l) => linkKey(l) === id);
      if (found) this.change(P.setSource(this.draft, found.to.step, found.to.port, null));
    }
  }

  // ---- drawing

  render() {
    const focused = document.activeElement?.closest?.("[data-step].node")?.dataset.step;
    if (focused && this.stepLayer.contains(document.activeElement)) this.focusAfter ??= focused;
    const { x, y, k } = this.view;
    this.viewport.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
    this.linkLayer.replaceChildren();
    this.stepLayer.replaceChildren();
    for (const l of P.links(this.draft)) this.drawLink(l);
    for (const step of this.draft.steps) this.drawStep(step);
    if (this.focusAfter) {                                     // a redraw replaces the focused element
      this.stepLayer.querySelector(`[data-step="${CSS.escape(this.focusAfter)}"].node`)?.focus();
      this.focusAfter = null;
    }
  }

  at(name) {
    return this.draft.layout[name] ?? { x: 40, y: 40 };
  }

  drawLink(l) {
    const source = this.draft.steps.find((s) => s.name === l.from.step);
    const target = this.draft.steps.find((s) => s.name === l.to.step);
    if (!source || !target) return;
    const out = portsOf(source, this.tools).outputs.indexOf(l.from.output);
    const inp = portsOf(target, this.tools).inputs.indexOf(l.to.port);
    if (out < 0 || inp < 0) return;
    const a = this.at(source.name);
    const b = this.at(target.name);
    const id = linkKey(l);
    const d = curve(a.x + WIDTH, portY(a, out), b.x, portY(b, inp));
    const selected = this.selected?.kind === "link" && this.selected.id === id;
    el("path", { d, class: "edge-hit", "data-link": id }, this.linkLayer);
    el("path", { d, class: `edge${selected ? " selected" : ""}` }, this.linkLayer);
  }

  drawStep(step) {
    const { inputs, outputs } = portsOf(step, this.tools);
    const at = this.at(step.name);
    const status = this.statuses[step.name];
    const selected = this.selected?.kind === "step" && this.selected.id === step.name;
    const known = P.key(step.tool) in this.tools;
    const g = el("g", {
      class: `node status-${status ?? "none"}${selected ? " selected" : ""}${known ? "" : " unknown"}`,
      transform: `translate(${at.x},${at.y})`, "data-step": step.name,
      tabindex: 0, role: "button", "aria-pressed": String(selected),
      "aria-label": `step ${step.name}${status ? `, ${status}` : ""}`,
    }, this.stepLayer);
    el("rect", { class: "node-box", width: WIDTH, height: heightOf(step, this.tools), rx: 6 }, g);
    el("rect", { class: "node-head", width: WIDTH, height: HEAD - 6, rx: 6 }, g);
    el("text", { class: "node-title", x: 10, y: 17 }, g).textContent = step.name;
    if (status) {
      el("text", { class: "node-status", x: WIDTH - 10, y: 17, "text-anchor": "end" }, g).textContent = status;
    }
    inputs.forEach((name, i) => this.drawPort(g, step, name, "in", i));
    outputs.forEach((name, i) => this.drawPort(g, step, name, "out", i));
  }

  drawPort(g, step, name, side, index) {
    const cx = side === "in" ? 0 : WIDTH;
    const cy = HEAD + index * ROW + ROW / 2;
    let fit = "";
    if (this.drag?.kind === "wire" && side === "in") {
      fit = P.linkProblem(this.draft, this.tools, this.drag.from, { step: step.name, port: name }, this.dataLegos)
        ? " refuses" : " accepts";
    }
    const port = el("circle", { class: `port port-${side}${fit}`, cx, cy, r: 6,
                                "data-port": name, "data-side": side, "data-step": step.name }, g);
    el("title", {}, port).textContent = `${step.name}.${name}`;
    el("text", { class: "port-label", x: side === "in" ? 12 : WIDTH - 12, y: cy + 4,
                 "text-anchor": side === "in" ? "start" : "end" }, g).textContent = name;
  }

  // ---- pointer: drag a step, wire an output to an input, pan the canvas

  cancelDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.wire?.remove();
    this.wire = null;
    this.render();
  }

  pointerDown(e) {
    if (e.button !== 0 || this.drag) return;                    // one gesture at a time
    const at = this.toGraph(e.clientX, e.clientY);
    const port = e.target.closest?.("[data-side]");
    const linkHit = e.target.closest?.("[data-link]");
    const stepHit = e.target.closest?.("[data-step]");
    if (port && port.dataset.side === "out" && !this.readOnly) {
      this.drag = { kind: "wire", from: { step: port.dataset.step, output: port.dataset.port } };
      this.wire = el("path", { class: "edge wiring" }, this.overlay);
    } else if (linkHit) {
      this.select({ kind: "link", id: linkHit.dataset.link });
      return;
    } else if (stepHit) {
      const name = stepHit.dataset.step;
      const p = this.at(name);
      this.drag = { kind: "step", name, dx: at.x - p.x, dy: at.y - p.y, moved: false };
      this.select({ kind: "step", id: name });
    } else {
      this.drag = { kind: "pan", x: e.clientX - this.view.x, y: e.clientY - this.view.y };
      if (this.selected) this.select(null);
    }
    this.svg.setPointerCapture(e.pointerId);
    this.render();
    e.preventDefault();
  }

  pointerMove(e) {
    const drag = this.drag;
    if (!drag) return;
    if (drag.kind === "pan") {
      this.view = { ...this.view, x: e.clientX - drag.x, y: e.clientY - drag.y };
      this.viewport.setAttribute("transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    } else if (drag.kind === "step" && !this.readOnly) {
      const at = this.toGraph(e.clientX, e.clientY);
      this.draft = P.moveStep(this.draft, drag.name, at.x - drag.dx, at.y - drag.dy);
      drag.moved = true;
      this.render();
    } else if (drag.kind === "wire") {
      const source = this.draft.steps.find((s) => s.name === drag.from.step);
      const index = portsOf(source, this.tools).outputs.indexOf(drag.from.output);
      const a = this.at(source.name);
      const at = this.toGraph(e.clientX, e.clientY);
      this.wire.setAttribute("d", curve(a.x + WIDTH, portY(a, index), at.x, at.y));
    }
  }

  pointerUp(e) {
    const drag = this.drag;
    this.drag = null;                                           // first: releasing capture fires lostpointercapture
    if (this.svg.hasPointerCapture?.(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (!drag) return;
    if (drag.kind === "step" && drag.moved) this.change(this.draft);
    if (drag.kind === "wire") {
      this.wire?.remove();
      this.wire = null;
      const port = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-side="in"]');
      if (port) {
        try {
          this.change(P.link(this.draft, this.tools, drag.from, { step: port.dataset.step, port: port.dataset.port },
                             this.dataLegos));
        } catch (err) {
          this.onProblem(err.message);
        }
      }
      this.render();
    }
  }

  zoom(e) {
    e.preventDefault();
    const r = this.svg.getBoundingClientRect();
    const k = Math.min(2.5, Math.max(0.3, this.view.k * Math.exp(-e.deltaY * 0.0015)));
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    this.view = { k, x: px - ((px - this.view.x) * k) / this.view.k, y: py - ((py - this.view.y) * k) / this.view.k };
    this.render();
  }
}
