"""The studio's JSON API, between the browser and the services: it holds no state and runs nothing.

Every call goes to the registry or /ogc as the user (their Keycloak token), and the answer comes back as
the service gave it. Pipelines run where the backend runs them (Argo now, an HPC adapter later): the studio
only publishes, starts, reads and dismisses. Tethys-free, so it's tested without a portal; controllers.py
is the Tethys glue.

What a failure becomes for the browser (always {"error": <text>}):
- BadRequest (a body the browser shouldn't send): 400
- Unauthorized: 401 ({"login": <url>} is added by the controller)
- Refused: the service's own status (400, 403, 404, 409, 422)
- Unavailable: 503; OutcomeUnknown: 502 with "outcome": "unknown"; any other ServiceError: 502
"""
import json
from contextlib import contextmanager
from typing import Any, Callable

from .ogc import OgcClient
from .registry import RegistryClient
from .service import OutcomeUnknown, Refused, ServiceError, Unauthorized, Unavailable


class BadRequest(Exception):
    """A request body this API doesn't take; `str()` says why."""


class Clients:
    def __init__(self, ogc: OgcClient, registry: RegistryClient):
        self.ogc, self.registry = ogc, registry


@contextmanager
def clients(ogc_url: str, registry_url: str, token: Callable[[], str]):
    """Both services' clients for one request, with the user's token; closed afterwards."""
    with OgcClient(ogc_url, token) as ogc, RegistryClient(registry_url, token) as registry:
        yield Clients(ogc, registry)


def answer(call: Callable[[], Any], ok: int = 200) -> tuple[int, Any]:
    """(HTTP status, JSON body) for one call: its result, or what its failure becomes (see the module)."""
    try:
        return ok, call()
    except BadRequest as err:
        return 400, {"error": str(err)}
    except Unauthorized as err:
        return 401, {"error": str(err)}
    except Refused as err:
        return err.status, {"error": str(err)}
    except Unavailable as err:
        return 503, {"error": str(err)}
    except OutcomeUnknown as err:
        return 502, {"error": str(err), "outcome": "unknown"}
    except ServiceError as err:
        return 502, {"error": str(err)}


def json_body(raw: bytes) -> Any:
    try:
        return json.loads(raw or b"null")
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("the body isn't JSON") from None


def lego_body(raw: bytes) -> dict:
    """A lego to publish: a JSON object. What makes it a valid lego is the registry's to say."""
    body = json_body(raw)
    if not isinstance(body, dict):
        raise BadRequest("publish a lego as a JSON object")
    return body


def inputs_body(raw: bytes) -> dict:
    """An execute body: {"inputs": {name: value}}. Whether the inputs fit the pipeline is /ogc's to say."""
    body = json_body(raw)
    if not isinstance(body, dict) or not isinstance(body.get("inputs"), dict) or set(body) != {"inputs"}:
        raise BadRequest('run a pipeline with {"inputs": {<name>: <value>, ...}}')
    return body["inputs"]


def respond(method: str, methods: dict[str, Callable[[Clients], Any]], authenticated: bool,
            open_clients: Callable[[], Any], login_url: str, ok: int = 200) -> tuple[int, Any, dict]:
    """(status, JSON body, headers) for one request to an api/ route. `methods` maps each HTTP method the
    route takes to its call; `open_clients()` gives the context manager of the user's clients. A user who
    isn't logged in, or whose login is over, gets 401 with `login_url`; never a redirect to an HTML page."""
    call = methods.get(method)
    if call is None:
        return 405, {"error": f"use {' or '.join(methods)}"}, {"Allow": ", ".join(methods)}
    if not authenticated:
        return 401, {"error": "log in to use the studio", "login": login_url}, {}
    with open_clients() as c:
        status, body = answer(lambda: call(c), ok=ok if method == "POST" else 200)
    if status == 401:
        body["login"] = login_url
    return status, body, {}


# ---- the calls, by route: (clients, request body) -> the answer

def legos(c: Clients, kind: str | None) -> list:
    return c.registry.legos(kind or None)


def lego(c: Clients, lego_id: str, version: str) -> dict:
    return c.registry.lego(lego_id, version)


def publish(c: Clients, raw: bytes) -> dict:
    return c.registry.publish(lego_body(raw))


def process(c: Clients, process_id: str) -> dict:
    return c.ogc.describe(process_id)


def run(c: Clients, process_id: str, raw: bytes) -> dict:
    return c.ogc.execute(process_id, inputs_body(raw))


def jobs(c: Clients) -> list:
    return c.ogc.jobs()


def job(c: Clients, job_id: str) -> dict:
    return c.ogc.job(job_id)


def steps(c: Clients, job_id: str) -> dict:
    return c.ogc.steps(job_id)


def results(c: Clients, job_id: str) -> dict:
    return c.ogc.results(job_id)


def dismiss(c: Clients, job_id: str) -> dict:
    c.ogc.dismiss(job_id)
    return {"jobID": job_id, "status": "dismissed"}
