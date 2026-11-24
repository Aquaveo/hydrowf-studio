import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/pipeline.js";

// A small catalogue shaped like the shipped legos (hydrowf-ogc registry/legos.yaml).
const TOOLS = Object.fromEntries([
  { id: "ngiab-preprocess", version: "0.1.0", title: "Preprocess",
    inputs: [{ name: "feature", type: "string", pattern: "^(?:gage-[0-9]+)$" },
             { name: "hydrofabric", type: "file", data: "hydrofabric-gpkg", path: "hf.gpkg" }],
    outputs: [{ name: "ngen_run", type: "directory", data: "ngen-run", path: "run" }] },
  { id: "ngiab-run", version: "2.1.0", title: "Run",
    inputs: [{ name: "ngen_run", type: "directory", data: "ngen-run", path: "run" }],
    outputs: [{ name: "ngen_run", type: "directory", data: "ngen-run", path: "run" }] },
  { id: "ngiab-to-cng", version: "0.4.1", title: "To CNG",
    inputs: [{ name: "ngen_run", type: "directory", data: "ngen-run", path: "run" },
             { name: "configuration_name", type: "string", default: "ngiab_cfe" }],
    outputs: [{ name: "cng", type: "directory", formats: ["ngen-cng", "teehr-timeseries"], path: "cng" }] },
  { id: "teehr-evaluate", version: "0.1.1", title: "Evaluate",
    inputs: [{ name: "timeseries", type: "dataset", data: "teehr-timeseries" },
             { name: "metrics", type: "string", default: "kge" }],
    outputs: [{ name: "evaluation", type: "directory", data: "teehr-metrics", path: "eval" },
              { name: "summary", type: "string" }] },
  { id: "forcing-reader", version: "1.0.0", title: "Reads forcing", network: true,
    inputs: [{ name: "forcing", type: "dataset", data: "nwm-forcing" },
             { name: "count", type: "int" }],
    outputs: [{ name: "out", type: "directory", data: "ngen-run", path: "out" }] },
  { id: "run-reader", version: "1.0.0", title: "Reads a run in place",
    inputs: [{ name: "ngen_run", type: "dataset", data: "ngen-run" }],
    outputs: [] },
].map((t) => [P.key(t), t]));
const tool = (id) => Object.values(TOOLS).find((t) => t.id === id);
const DATA = [
  { id: "hydrofabric-gpkg", version: "2.2.0", data_kind: "managed", storage: { driver: "stac", location: "managed/hf/conus.gpkg" } },
  { id: "hydrofabric-gpkg", version: "2.10.0", data_kind: "managed", storage: { driver: "stac", location: "managed/hf/v210/" } },
  { id: "hydrofabric-gpkg", version: "9.0.0", data_kind: "output", storage: { driver: "stac" } },
  { id: "nwm-forcing", version: "1.0.0", data_kind: "external", storage: { driver: "external", url: "s3://noaa/x" } },
  { id: "ngen-run", version: "1.0.0", data_kind: "output", storage: { driver: "stac", archive: "tgz" } },
  { id: "teehr-timeseries", version: "1.0.0", data_kind: "output", storage: { driver: "stac", archive: "none" } },
];

function chain() {
  let d = { ...P.emptyDraft(), id: "my-flow", title: "My flow" };
  for (const id of ["ngiab-preprocess", "ngiab-run", "ngiab-to-cng"]) d = P.addStep(d, tool(id)).draft;
  d = P.link(d, TOOLS, { step: "ngiab-preprocess", output: "ngen_run" }, { step: "ngiab-run", port: "ngen_run" });
  d = P.link(d, TOOLS, { step: "ngiab-run", output: "ngen_run" }, { step: "ngiab-to-cng", port: "ngen_run" });
  return d;
}

test("steps get unique names from their tool, and their file and directory outputs are kept", () => {
  let d = P.addStep(P.emptyDraft(), tool("ngiab-run")).draft;
  const second = P.addStep(d, tool("ngiab-run"));
  assert.deepEqual(second.draft.steps.map((s) => s.name), ["ngiab-run", "ngiab-run-2"]);
  d = P.addStep(d, tool("teehr-evaluate")).draft;
  assert.deepEqual(d.results, ["ngiab-run.ngen_run", "teehr-evaluate.evaluation"]);    // not the string output
});

test("an output another step reads is no longer kept by default", () => {
  assert.deepEqual(chain().results, ["ngiab-to-cng.cng"]);
});

test("a link must carry the data lego the port wants", () => {
  let d = P.addStep(chain(), tool("teehr-evaluate")).draft;
  const from = { step: "ngiab-to-cng", output: "cng" };
  const to = { step: "teehr-evaluate", port: "timeseries" };
  assert.match(P.linkProblem(d, TOOLS, from, to), /is directory of ngen-cng; .* wants dataset of teehr-timeseries/);
  d = P.setFormat(d, "ngiab-to-cng", "cng", "teehr-timeseries");     // the format the step writes
  assert.equal(P.linkProblem(d, TOOLS, from, to), null);              // a dataset port reads it in place
});

test("links the registry would refuse are refused", () => {
  const d = P.addStep(chain(), tool("teehr-evaluate")).draft;
  const run = { step: "ngiab-run", port: "ngen_run" };
  assert.match(P.linkProblem(d, TOOLS, { step: "ngiab-run", output: "ngen_run" }, run), /can't feed itself/);
  assert.match(P.linkProblem(d, TOOLS, { step: "ngiab-preprocess", output: "ngen_run" }, run), /already linked/);
  assert.match(P.linkProblem(d, TOOLS, { step: "teehr-evaluate", output: "summary" },
                             { step: "ngiab-preprocess", port: "hydrofabric" }), /is a string output/);
  assert.match(P.linkProblem(d, TOOLS, { step: "ngiab-to-cng", output: "nope" },
                             { step: "ngiab-preprocess", port: "hydrofabric" }), /has no output nope/);
  const back = P.setSource(d, "ngiab-preprocess", "hydrofabric", null);
  assert.match(P.linkProblem(back, TOOLS, { step: "ngiab-run", output: "ngen_run" },
                             { step: "ngiab-preprocess", port: "hydrofabric" }), /wants file of hydrofabric-gpkg/);
  assert.throws(() => P.link(d, TOOLS, { step: "ngiab-run", output: "ngen_run" }, run), /can't feed itself/);
});

test("a link that would close a cycle is refused", () => {
  let d = P.emptyDraft();
  d = P.addStep(d, tool("ngiab-run")).draft;
  d = P.addStep(d, tool("ngiab-run")).draft;
  d = P.link(d, TOOLS, { step: "ngiab-run", output: "ngen_run" }, { step: "ngiab-run-2", port: "ngen_run" });
  assert.match(P.linkProblem(d, TOOLS, { step: "ngiab-run-2", output: "ngen_run" },
                             { step: "ngiab-run", port: "ngen_run" }), /cycle/);
});

test("removing a step removes its links and results", () => {
  const d = P.removeStep(chain(), "ngiab-run");
  assert.deepEqual(P.links(d), []);
  assert.equal(d.layout["ngiab-run"], undefined);
  assert.deepEqual(d.results, ["ngiab-to-cng.cng"]);
});

test("the pipeline JSON: run inputs, constants, links, formats and outputs as hydrowf-core has them", () => {
  let d = chain();
  d = P.setSource(d, "ngiab-preprocess", "feature", { input: true });
  d = P.setSource(d, "ngiab-preprocess", "hydrofabric", { data: { id: "hydrofabric-gpkg", version: "2.2.0" } });
  d = P.setSource(d, "ngiab-to-cng", "configuration_name", { value: "ngiab_mine" });
  d = P.setFormat(d, "ngiab-to-cng", "cng", "ngen-cng");
  d = P.setResult(d, "ngiab-run", "ngen_run", true);
  assert.deepEqual(P.toPipeline(d, TOOLS), {
    kind: "pipeline", id: "my-flow", version: "0.1.0", title: "My flow", description: "", visibility: "owner",
    inputs: [{ name: "feature", type: "string", pattern: "^(?:gage-[0-9]+)$" }],          // no `path`
    steps: [
      { name: "ngiab-preprocess", tool: { id: "ngiab-preprocess", version: "0.1.0" },
        inputs: { feature: { input: "feature" }, hydrofabric: { data: { id: "hydrofabric-gpkg", version: "2.2.0" } } } },
      { name: "ngiab-run", tool: { id: "ngiab-run", version: "2.1.0" },
        inputs: { ngen_run: { step: "ngiab-preprocess", output: "ngen_run" } } },
      { name: "ngiab-to-cng", tool: { id: "ngiab-to-cng", version: "0.4.1" },
        inputs: { ngen_run: { step: "ngiab-run", output: "ngen_run" }, configuration_name: { value: "ngiab_mine" } },
        formats: { cng: "ngen-cng" } },
    ],
    outputs: { cng: { step: "ngiab-to-cng", output: "cng" }, ngen_run: { step: "ngiab-run", output: "ngen_run" } },
  });
});

test("two steps asking for the same input name each get their own pipeline input", () => {
  let d = P.emptyDraft();
  d = P.addStep(d, tool("ngiab-preprocess")).draft;
  d = P.addStep(d, tool("ngiab-preprocess")).draft;
  d = P.setSource(d, "ngiab-preprocess", "feature", { input: true });
  d = P.setSource(d, "ngiab-preprocess-2", "feature", { input: true });
  const p = P.toPipeline(d, TOOLS);
  assert.deepEqual(p.inputs.map((i) => i.name), ["ngiab_preprocess_feature", "ngiab_preprocess_2_feature"]);
  assert.deepEqual(p.steps[1].inputs.feature, { input: "ngiab_preprocess_2_feature" });
  assert.deepEqual(Object.keys(p.outputs), ["ngiab-preprocess-ngen_run", "ngiab-preprocess-2-ngen_run"]);
});

test("a published pipeline opens as a draft that publishes the same pipeline", () => {
  let d = P.setSource(chain(), "ngiab-preprocess", "feature", { input: true });
  d = P.setSource(d, "ngiab-preprocess", "hydrofabric", { input: true });
  const published = P.toPipeline(d, TOOLS);
  const reopened = P.fromPipeline(published);
  assert.deepEqual(P.toPipeline(reopened, TOOLS), published);
  assert.deepEqual(Object.keys(reopened.layout), ["ngiab-preprocess", "ngiab-run", "ngiab-to-cng"]);
  assert.ok(reopened.layout["ngiab-to-cng"].x > reopened.layout["ngiab-run"].x);       // arranged by depth
});

test("problems name what the registry would refuse", () => {
  assert.deepEqual(P.problems(P.emptyDraft(), TOOLS),
                   ["the pipeline needs an id: lowercase letters, digits, . and -, at most 63", "the pipeline needs a title",
                    "add at least one step"]);
  assert.deepEqual(P.problems(chain(), TOOLS),
                   ["ngiab-preprocess: feature is required", "ngiab-preprocess: hydrofabric is required"]);
  const unknown = { ...chain(), steps: [{ name: "x", tool: { id: "gone", version: "1.0.0" }, inputs: {}, formats: {} }] };
  assert.deepEqual(P.problems(unknown, TOOLS), ["x: tool gone@1.0.0 isn't in the registry"]);
});


test("a constant must be what hydrowf-core's value_problem takes: typed, and matching the whole pattern", () => {
  const port = { name: "name", type: "string", pattern: "[a-z_]+" };                    // no anchors of its own
  assert.equal(P.valueProblem(port, "ngiab_mine"), null);
  assert.match(P.valueProblem(port, "Not-This"), /does not match/);                      // a search would find "ot"
  assert.match(P.valueProblem({ type: "int" }, ""), /is not a int/);
  assert.match(P.valueProblem({ type: "int" }, 2 ** 60), /too large for this page/);     // past what JS keeps exactly
  assert.equal(P.valueProblem({ type: "float" }, 3), null);
  assert.match(P.valueProblem({ type: "boolean" }, "true"), /is not a boolean/);
  assert.match(P.valueProblem({ type: "file", data: "x" }, "s3://b/k"), /can't take a constant/);
});

test("problems check every constant, data lego, link and format the editor can see", () => {
  let d = P.setSource(chain(), "ngiab-preprocess", "feature", { value: "gage-01" });
  d = P.setSource(d, "ngiab-preprocess", "hydrofabric", { data: { id: "hydrofabric-gpkg", version: "2.2.0" } });
  assert.deepEqual(P.problems(d, TOOLS, DATA), []);
  const bad = P.setSource(d, "ngiab-preprocess", "feature", { value: "station-1" });
  assert.deepEqual(P.problems(bad, TOOLS, DATA), ['ngiab-preprocess.feature: "station-1" does not match ^(?:gage-[0-9]+)$']);
  const dir = P.setSource(d, "ngiab-preprocess", "hydrofabric", { data: { id: "hydrofabric-gpkg", version: "2.10.0" } });
  assert.match(P.problems(dir, TOOLS, DATA)[0], /is a directory .* wants a file/);
  const stray = P.setSource(d, "ngiab-run", "colour", { value: "red" });
  assert.deepEqual(P.problems(stray, TOOLS, DATA), ["ngiab-run: ngiab-run has no input colour"]);
  const format = P.setFormat(d, "ngiab-to-cng", "cng", "nope");
  assert.deepEqual(P.problems(format, TOOLS, DATA), ["ngiab-to-cng: cng can't be written as nope"]);
});

test("changing a format re-checks the links that read it", () => {
  let d = P.addStep(chain(), tool("teehr-evaluate")).draft;
  d = P.setFormat(d, "ngiab-to-cng", "cng", "teehr-timeseries");
  d = P.link(d, TOOLS, { step: "ngiab-to-cng", output: "cng" }, { step: "teehr-evaluate", port: "timeseries" }, DATA);
  d = P.setFormat(d, "ngiab-to-cng", "cng", "ngen-cng");                                // the link no longer fits
  assert.ok(P.problems(d, TOOLS, DATA).some((p) => p.startsWith("teehr-evaluate.timeseries: ngiab-to-cng.cng is directory of ngen-cng")));
});

test("a dataset port can't read in place an output its data lego keeps as one .tgz", () => {
  const d = P.addStep(chain(), tool("run-reader")).draft;
  const from = { step: "ngiab-run", output: "ngen_run" };
  const to = { step: "run-reader", port: "ngen_run" };
  assert.match(P.linkProblem(d, TOOLS, from, to, DATA), /stored as one \.tgz/);
  assert.equal(P.linkProblem(d, TOOLS, from, to, []), null);                            // unknown storage: allowed
});

test("a port is offered the data legos it can take by id, oldest version first", () => {
  const hf = tool("ngiab-preprocess").inputs[1];
  assert.deepEqual(P.dataChoices(hf, tool("ngiab-preprocess"), DATA).map((x) => x.version), ["2.2.0"]);  // not the dir, not output
  const forcing = tool("forcing-reader").inputs[0];
  assert.deepEqual(P.dataChoices(forcing, tool("forcing-reader"), DATA).map((x) => x.id), ["nwm-forcing"]);
  assert.match(P.dataSourceProblem(forcing, DATA[3], { ...tool("forcing-reader"), network: false }), /must declare network: true/);
  assert.match(P.dataSourceProblem({ ...forcing, type: "file" }, DATA[3], tool("forcing-reader")), /feeds a dataset port/);
  assert.match(P.dataSourceProblem(hf, { id: "hydrofabric-gpkg", storage: { driver: "iceberg" } }, tool("ngiab-preprocess")),
               /iceberg data .* feeds a dataset port/);
});

test("the outputs a port could be linked from, for choosing without a pointer", () => {
  const d = P.addStep(chain(), tool("teehr-evaluate")).draft;
  assert.deepEqual(P.linkChoices(d, TOOLS, { step: "ngiab-to-cng", port: "ngen_run" }, DATA),
                   ["ngiab-preprocess.ngen_run", "ngiab-run.ngen_run"]);               // the one it has, and another
});

test("a published input fed to two steps comes back as one input, with its own description", () => {
  const published = P.toPipeline(chain(), TOOLS);
  published.inputs = [{ name: "gage", type: "string", description: "a USGS gage", default: "gage-01" }];
  published.steps[0].inputs.feature = { input: "gage" };
  let d = P.fromPipeline(published);
  d = P.addStep(d, tool("ngiab-preprocess")).draft;
  d = P.setSource(d, "ngiab-preprocess-2", "feature", { input: "gage" });
  const again = P.toPipeline(d, TOOLS);
  assert.deepEqual(again.inputs, [{ name: "gage", type: "string", description: "a USGS gage", default: "gage-01" }]);
  assert.deepEqual(again.steps.at(-1).inputs.feature, { input: "gage" });
});

test("a new run input never takes a name another input has", () => {
  let d = P.addStep(P.emptyDraft(), tool("ngiab-preprocess")).draft;
  d = P.setSource(d, "ngiab-preprocess", "feature", { input: "feature" });              // named: kept
  d = P.addStep(d, tool("ngiab-preprocess")).draft;
  d = P.setSource(d, "ngiab-preprocess-2", "feature", { input: true });                 // new: not "feature"
  assert.deepEqual(P.toPipeline(d, TOOLS).inputs.map((i) => i.name), ["feature", "ngiab_preprocess_2_feature"]);
});

test("a pipeline whose tools give no file or directory output can still be published", () => {
  let d = { ...P.emptyDraft(), id: "reader", title: "Reader" };
  d = P.addStep(d, tool("run-reader")).draft;
  d = P.setSource(d, "run-reader", "ngen_run", { input: true });
  assert.deepEqual(P.problems(d, TOOLS, DATA), []);
});

test("length limits are hydrowf-core's", () => {
  const d = { ...chain(), id: "a".repeat(64), title: "t".repeat(201) };
  const found = P.problems(d, TOOLS, DATA);
  assert.ok(found.includes("the pipeline needs an id: lowercase letters, digits, . and -, at most 63"));
  assert.ok(found.includes("the title is at most 200 characters"));
});

test("a stored or imported draft is checked and completed before it is kept", () => {
  assert.deepEqual(P.normalizeDraft({ steps: [{ name: "a", tool: { id: "t", version: "1.0.0" } }], results: null }),
                   { id: "", version: "0.1.0", title: "", description: "", inputs: {}, results: [],
                     steps: [{ name: "a", tool: { id: "t", version: "1.0.0" }, inputs: {}, formats: {} }],
                     layout: { a: { x: 40, y: 40 } } });
  for (const bad of [null, [], { steps: "x" }, { steps: [{ name: "a" }] }, { steps: [{ name: "a", tool: { id: "t" } }] },
                     { steps: [{ name: 1, tool: { id: "t", version: "1" } }] }]) {
    assert.throws(() => P.normalizeDraft(bad));
  }
});


test("a default of false or an empty text is kept when the input is published", () => {
  const flags = { id: "flags", version: "1.0.0", title: "Flags",
                  inputs: [{ name: "verbose", type: "boolean", default: false, optional: false, description: "" },
                           { name: "suffix", type: "string", default: "" }],
                  outputs: [] };
  const tools = { ...TOOLS, [P.key(flags)]: flags };
  let d = P.addStep(P.emptyDraft(), flags).draft;
  d = P.setSource(d, "flags", "verbose", { input: true });
  d = P.setSource(d, "flags", "suffix", { input: true });
  assert.deepEqual(P.toPipeline(d, tools).inputs, [{ name: "verbose", type: "boolean", default: false },
                                                   { name: "suffix", type: "string", default: "" }]);
});

test("a new run input never takes a published input's name or spec", () => {
  let d = { ...P.emptyDraft(), inputs: { feature: { name: "feature", type: "int", description: "left over" } } };
  d = P.addStep(d, tool("ngiab-preprocess")).draft;
  d = P.setSource(d, "ngiab-preprocess", "feature", { input: true });
  assert.deepEqual(P.toPipeline(d, TOOLS).inputs, [{ name: "ngiab_preprocess_feature", type: "string",
                                                    pattern: "^(?:gage-[0-9]+)$" }]);
});

test("only hydrowf-core's four source shapes survive a stored or imported draft", () => {
  const raw = { steps: [{ name: "a", tool: { id: "t", version: "1.0.0" }, inputs: {
    ok1: { value: 3 }, ok2: { input: true }, ok3: { input: "gage" }, ok4: { step: "b", output: "o" },
    ok5: { data: { id: "d", version: "1.0.0" } },
    bad1: {}, bad2: { value: { x: 1 } }, bad3: { input: "Not A Name" }, bad4: { step: "b" }, bad5: { value: 1, extra: 2 } } }] };
  assert.deepEqual(Object.keys(P.normalizeDraft(raw).steps[0].inputs), ["ok1", "ok2", "ok3", "ok4", "ok5"]);
});

test("a step name used twice is a problem", () => {
  const d = chain();
  const twice = { ...d, steps: [...d.steps, { ...d.steps[0] }] };
  assert.ok(P.problems(twice, TOOLS, DATA).includes("step name ngiab-preprocess is used twice"));
});
