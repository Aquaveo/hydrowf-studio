// The studio's JSON API (controllers.py, api.py): every call runs on the server as the logged-in user.
// A failure is an ApiError with the server's status and message; `login` (a 401) is where to log in again,
// and outcome "unknown" means a run or dismiss may have happened anyway.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `the studio answered ${status}`);
    Object.assign(this, { status, login: body?.login ?? null, outcome: body?.outcome ?? null });
  }
}

export function csrfToken(cookie) {
  const found = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("csrftoken="));
  return found ? decodeURIComponent(found.slice("csrftoken=".length)) : "";
}

const part = (value) => encodeURIComponent(value).replace(/%40/g, "@");     // ids keep their <id>@<version>

export class Api {
  constructor(base, { fetch: get = globalThis.fetch.bind(globalThis), cookie = () => document.cookie } = {}) {
    Object.assign(this, { base, get, cookie });
  }

  async call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (method !== "GET") Object.assign(headers, { "Content-Type": "application/json", "X-CSRFToken": csrfToken(this.cookie()) });
    let response;
    try {
      response = await this.get(this.base + path, { method, headers, credentials: "same-origin",
                                                    body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, { error: "the studio can't be reached" });
    }
    let answer = null;
    try { answer = await response.json(); } catch { /* not JSON: a proxy's page, Django's CSRF 403 */ }
    if (!response.ok) {
      if (response.status === 403 && answer === null) throw new ApiError(403, { error: "the page is out of date: reload it" });
      throw new ApiError(response.status, answer);
    }
    if (answer === null) throw new ApiError(response.status, { error: "the studio answered something that isn't JSON" });
    return answer;
  }

  tools() { return this.call("GET", "legos/?kind=tool"); }
  dataLegos() { return this.call("GET", "legos/?kind=data"); }
  pipelines() { return this.call("GET", "legos/?kind=pipeline"); }
  publish(pipeline) { return this.call("POST", "legos/", pipeline); }
  process(id) { return this.call("GET", `processes/${part(id)}/`); }
  run(id, inputs) { return this.call("POST", `processes/${part(id)}/execution/`, { inputs }); }
  jobs() { return this.call("GET", "jobs/"); }
  job(id) { return this.call("GET", `jobs/${part(id)}/`); }
  steps(id) { return this.call("GET", `jobs/${part(id)}/steps/`); }
  results(id) { return this.call("GET", `jobs/${part(id)}/results/`); }
  dismiss(id) { return this.call("DELETE", `jobs/${part(id)}/`); }
}

/** The newest version of each id, from a registry list (by id, then version oldest first). */
export function newest(legos) {
  const byId = new Map();
  for (const lego of legos) {
    const seen = byId.get(lego.id);
    if (!seen || semver(lego.version) > semver(seen.version)) byId.set(lego.id, lego);
  }
  return [...byId.values()];
}

const semver = (v) => v.split(".").map((n) => n.padStart(8, "0")).join(".");
