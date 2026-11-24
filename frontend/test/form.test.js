import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldsFor, modeOf, outputsFor, parseValue, runProblem } from "../src/form.js";

const TOOL = {
  id: "ngiab-to-cng", version: "0.4.1",
  inputs: [{ name: "ngen_run", type: "directory", data: "ngen-run" },
           { name: "configuration_name", type: "string", default: "ngiab_cfe", pattern: "^(?:[a-z_]+)$" },
           { name: "hydrofabric", type: "file", data: "hydrofabric-gpkg", optional: true }],
  outputs: [{ name: "cng", type: "directory", formats: ["ngen-cng", "teehr-timeseries"] },
            { name: "count", type: "int" }],
};
const DATA = [{ id: "hydrofabric-gpkg", version: "2.2.0", data_kind: "managed",
                storage: { driver: "stac", location: "managed/hf/conus.gpkg" } },
              { id: "hydrofabric-gpkg", version: "9.0.0", data_kind: "output", storage: { driver: "stac" } },   // not by id
              { id: "ngen-run", version: "1.0.0", data_kind: "output", storage: { driver: "stac" } }];

test("each source shape has its mode", () => {
  assert.deepEqual([null, { step: "a", output: "b" }, { input: true }, { data: { id: "x", version: "1.0.0" } },
                    { value: 3 }].map(modeOf), ["unset", "linked", "run", "data", "value"]);
});

test("a field offers the modes its port can take", () => {
  const step = { name: "to-cng", inputs: { ngen_run: { step: "run", output: "ngen_run" } }, formats: {} };
  const [linked, name, hydrofabric] = fieldsFor(step, TOOL, DATA, (port) => (port.name === "hydrofabric" ? ["prep.hf"] : []));
  assert.equal(linked.mode, "linked");
  assert.equal(linked.linkedFrom, "run.ngen_run");
  assert.deepEqual(linked.modes, ["unset", "run", "linked"]);             // no output data by id
  assert.deepEqual(name.modes, ["unset", "value", "run"]);
  assert.equal(name.required, false);                                     // it has a default
  assert.deepEqual(hydrofabric.modes, ["unset", "run", "data", "linked"]);          // linkable without a pointer
  assert.deepEqual(hydrofabric.dataChoices.map((d) => d.version), ["2.2.0"]);
});

test("outputs show their format choice and whether they're kept", () => {
  const step = { name: "to-cng", inputs: {}, formats: { cng: "teehr-timeseries" } };
  const [cng, count] = outputsFor(step, TOOL, { results: ["to-cng.cng"] });
  assert.deepEqual([cng.chosen, cng.kept, cng.linkable], ["teehr-timeseries", true, true]);
  assert.deepEqual([count.linkable, count.kept], [false, false]);
});

test("typed values are parsed as hydrowf-core checks them; a refused one is kept with its problem", () => {
  assert.deepEqual(parseValue({ type: "int" }, " 42 "), { value: 42 });
  assert.equal(parseValue({ type: "int" }, "4.2").value, "4.2");
  assert.ok(parseValue({ type: "int" }, "4.2").problem);
  assert.ok(parseValue({ type: "int" }, "").problem);                                    // an int with no default
  assert.deepEqual(parseValue({ type: "float" }, "4.2"), { value: 4.2 });
  assert.ok(parseValue({ type: "float" }, "").problem);
  assert.deepEqual(parseValue({ type: "boolean" }, true), { value: true });
  assert.deepEqual(parseValue({ type: "enum", symbols: ["a", "b"] }, "b"), { value: "b" });
  assert.ok(parseValue({ type: "enum", symbols: ["a", "b"] }, "c").problem);
  assert.deepEqual(parseValue(TOOL.inputs[1], "ngiab_mine"), { value: "ngiab_mine" });
  assert.ok(parseValue(TOOL.inputs[1], "Not-This").problem);
  assert.ok(parseValue({ type: "string", pattern: "[a-z]+" }, "Not-This").problem);     // the whole value, unanchored
  assert.ok(parseValue({ type: "string", pattern: "^(?:[0-9]+)$" }, "١٢").problem);     // ASCII only, like Rust's
  assert.deepEqual(parseValue({ type: "string", pattern: "(?<!x" }, "y"), { value: "y" });     // left to the registry
});


test("a data source stays shown as data when its data lego can no longer be chosen", () => {
  const step = { name: "to-cng", inputs: { hydrofabric: { data: { id: "hydrofabric-gpkg", version: "1.0.0" } } }, formats: {} };
  const hydrofabric = fieldsFor(step, TOOL, [])[2];
  assert.equal(hydrofabric.mode, "data");
  assert.ok(hydrofabric.modes.includes("data"));
});

test("a run field's value is checked like /ogc will", () => {
  const field = (extra) => ({ name: "x", type: "text", kind: "string", value: "", required: false, ...extra });
  assert.equal(runProblem(field({ type: "checkbox", required: true })), null);          // true or false: always a value
  assert.equal(runProblem(field({ required: true })), "x is required");
  assert.equal(runProblem(field({})), null);                                             // optional: left out
  assert.equal(runProblem(field({ type: "number", kind: "integer", badInput: true })), "x is a number");
  assert.equal(runProblem(field({ type: "number", kind: "integer", value: "4.5" })), "x is a whole number");
  assert.match(runProblem(field({ type: "number", kind: "integer", value: "9007199254740993" })), /too large/);
  assert.equal(runProblem(field({ value: "gage-1", pattern: "^(gage)-[0-9]+$" })), null);
  assert.match(runProblem(field({ value: "xgage-1", pattern: "(gage)-[0-9]+" })), /doesn't match/);   // the whole value
});
