import { test } from "node:test";
import assert from "node:assert/strict";
import { Api, ApiError, csrfToken, newest } from "../src/api.js";

function fakeFetch(status, body, { json = true } = {}) {
  const calls = [];
  const get = async (url, init) => {
    calls.push({ url, ...init });
    return { ok: status < 400, status, json: async () => { if (!json) throw new SyntaxError("html"); return body; } };
  };
  return { get, calls };
}

test("a GET asks for JSON; a POST sends JSON with the CSRF token", async () => {
  const { get, calls } = fakeFetch(201, { jobID: "j" });
  const api = new Api("/apps/hydrowf-studio/api/", { fetch: get, cookie: () => "a=1; csrftoken=t%2Bk; b=2" });
  assert.deepEqual(await api.run("my-flow@0.1.0", { feature: "gage-1" }), { jobID: "j" });
  assert.equal(calls[0].url, "/apps/hydrowf-studio/api/processes/my-flow@0.1.0/execution/");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["X-CSRFToken"], "t+k");
  assert.equal(calls[0].body, JSON.stringify({ inputs: { feature: "gage-1" } }));
  await api.jobs();
  assert.equal(calls[1].headers["X-CSRFToken"], undefined);
  assert.equal(calls[1].body, undefined);
});

test("ids are escaped in the path, keeping @", async () => {
  const { get, calls } = fakeFetch(200, {});
  await new Api("/api/", { fetch: get, cookie: () => "" }).job("../x y");
  assert.equal(calls[0].url, "/api/jobs/..%2Fx%20y/");
});

test("a failure carries the server's message, login and outcome", async () => {
  const login = "/oauth2/login/keycloak/?next=/apps/hydrowf-studio/";
  const expired = fakeFetch(401, { error: "your login has expired: log in again", login });
  await assert.rejects(new Api("/api/", { fetch: expired.get, cookie: () => "" }).jobs(),
                       (err) => err instanceof ApiError && err.status === 401 && err.login === login);
  const unknown = fakeFetch(502, { error: "may have done it anyway", outcome: "unknown" });
  await assert.rejects(new Api("/api/", { fetch: unknown.get, cookie: () => "" }).run("p", {}),
                       (err) => err.outcome === "unknown" && err.message === "may have done it anyway");
});

test("Django's HTML 403 (a stale CSRF token) asks for a reload; other non-JSON is an error", async () => {
  const csrf = fakeFetch(403, null, { json: false });
  await assert.rejects(new Api("/api/", { fetch: csrf.get, cookie: () => "" }).dismiss("j"), /reload/);
  const html = fakeFetch(200, null, { json: false });
  await assert.rejects(new Api("/api/", { fetch: html.get, cookie: () => "" }).jobs(), /isn't JSON/);
  const down = async () => { throw new TypeError("network"); };
  await assert.rejects(new Api("/api/", { fetch: down, cookie: () => "" }).jobs(), (err) => err.status === 0);
});

test("the newest version of each lego, by version order", () => {
  const legos = [{ id: "a", version: "0.9.0" }, { id: "a", version: "0.10.0" }, { id: "b", version: "1.0.0" }];
  assert.deepEqual(newest(legos).map((l) => `${l.id}@${l.version}`), ["a@0.10.0", "b@1.0.0"]);
});

test("csrfToken reads the cookie", () => {
  assert.equal(csrfToken("csrftoken=abc"), "abc");
  assert.equal(csrfToken("other=1"), "");
});
