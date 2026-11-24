"""What the studio's service clients share: requests with the user's bearer token, and what each failure means.

Tethys-free on purpose, so the clients are tested without a portal. The token is a callable asked before
every request; it raises Unauthorized itself when the login can't be refreshed.

Every failure is a ServiceError, and its class says what the caller should do:
- Unauthorized: the user logs in again.
- Refused: the service said no (bad input, not theirs, unknown, already exists); asking again won't change it.
- Unavailable: the request didn't get a usable answer and changed nothing; ask again later.
- OutcomeUnknown: a POST or DELETE may or may not have done its work (started a job, published a lego,
  dismissed a job); check first.
- ServiceError itself: an answer this client doesn't understand.
No message ever holds the token.

One client per thread: it keeps a requests.Session, which isn't meant to be shared across threads.
Redirects are never followed: a 3xx is an answer this client doesn't understand.
"""
from typing import Callable
from urllib.parse import quote

import requests
from urllib3.exceptions import MaxRetryError, NewConnectionError, SSLError as TLSError

try:  # Django's error reports leave these locals out of THESE frames only (requests' own frames still hold the
    # header): defence in depth, not a reason to run a portal with DEBUG=True where real tokens flow
    from django.views.decorators.debug import sensitive_variables
except ImportError:                           # outside a portal (the tests): nothing to hide from
    def sensitive_variables(*names):
        return lambda function: function

CHANGES = ("POST", "DELETE")                  # requests that may have done their work when the answer is lost

TRANSIENT = (408, 429)                       # request timeout, too many requests: nothing was done


class ServiceError(Exception):
    """Something a service refused or couldn't answer; `str()` is a message a user can read."""


class Unauthorized(ServiceError):
    """401, or a token that can't be sent: the user has to log in again."""


class Refused(ServiceError):
    """The service answered no (400 bad input, 403 not allowed, 404 unknown, 409 exists, 422 invalid)."""

    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status


class Unavailable(ServiceError):
    """No usable answer, and nothing changed (not reached, 408, 429, or a 5xx on a read): ask again later."""


class OutcomeUnknown(ServiceError):
    """A POST or DELETE that may have done its work (a timeout or 5xx after it was sent): check first."""


class ServiceClient:
    name = "the service"                     # how messages name it
    params: dict = {}                        # query parameters every request carries

    def __init__(self, base_url: str, token: Callable[[], str], session: requests.Session | None = None,
                 timeout: float = 30):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.own_session = session is None             # close() leaves a caller's session alone
        self.session = session or requests.Session()
        self.timeout = timeout

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self) -> None:
        if self.own_session:
            self.session.close()

    @sensitive_variables("headers")
    def _request(self, method: str, path: str, headers: dict | None = None, params: dict | None = None,
                 **kwargs) -> dict | list:
        headers = {"Authorization": f"Bearer {usable(self.token())}", "Accept": "application/json",
                   **(headers or {})}
        try:
            response = self.session.request(method, self.base_url + path, params={**self.params, **(params or {})},
                                            headers=headers, timeout=self.timeout, allow_redirects=False, **kwargs)
        except requests.RequestException as err:
            if method in CHANGES and not never_sent(err):
                raise OutcomeUnknown(f"{self.name} didn't answer in time: it may have done it anyway; check first") \
                    from None
            raise Unavailable(f"{self.name} can't be reached ({type(err).__name__})") from None
        status = response.status_code
        if status == 401:
            raise Unauthorized("your login has expired: log in again")
        if status >= 500 and method in CHANGES:
            raise OutcomeUnknown(f"{self.name} failed ({status}): it may have done it anyway; check first")
        if status >= 500 or status in TRANSIENT:
            raise Unavailable(f"{self.name} can't answer right now ({status})")
        if status >= 400:
            raise Refused(status, reason(response, self.name))
        if status >= 300:
            raise ServiceError(f"{self.name} answered {status}, a redirect: check its URL setting")
        try:
            body = response.json()
        except ValueError:
            raise ServiceError(f"{self.name} answered {status} with something that isn't JSON") from None
        if not isinstance(body, (dict, list)):
            raise ServiceError(f"{self.name} answered {status} with an unexpected body")
        return body

    def _dict(self, method: str, path: str, **kwargs) -> dict:
        body = self._request(method, path, **kwargs)
        if not isinstance(body, dict):
            raise ServiceError(f"{self.name} answered with a list where an object was expected")
        return body

    def _list(self, method: str, path: str, **kwargs) -> list:
        body = self._request(method, path, **kwargs)
        if not isinstance(body, list):
            raise ServiceError(f"{self.name} answered with an object where a list was expected")
        return body


def usable(token: str) -> str:
    """The token, if it can go in a header: whitespace or control characters make requests fail with the
    whole header in its message, and a non-ASCII one fails to encode (latin-1) outside requests' errors."""
    if not isinstance(token, str) or not token or not token.isascii() or not token.isprintable() \
            or any(c.isspace() for c in token):
        raise Unauthorized("your login token can't be used: log in again")
    return token


def never_sent(err: requests.RequestException) -> bool:
    """Whether the request failed before reaching the service (no connection made), so it changed nothing."""
    if isinstance(err, requests.ConnectTimeout):
        return True
    cause = err.args[0] if err.args else None
    if isinstance(err, requests.exceptions.SSLError):     # the handshake failed: urllib3 wraps it at connect time;
        return isinstance(cause, MaxRetryError) and isinstance(cause.reason, TLSError)   # a read's is raw
    return isinstance(err, requests.ConnectionError) and isinstance(getattr(cause, "reason", None), NewConnectionError)


def part(value: str) -> str:
    """A path part, escaped: ids come from the browser. `@` stays (process ids are <id>@<version>).
    "", "." and ".." are refused: escaping keeps them, and the URL would then name another route."""
    if not isinstance(value, str) or value in ("", ".", ".."):
        raise Refused(400, f"{value!r} is not an id")
    return quote(value, safe="@")


def reason(response: requests.Response, name: str) -> str:
    """The reason in an error body: pygeoapi's {"description"}, hydrowf-ogc's {"error"}, or FastAPI's
    {"detail"} (a text, or a list of {"loc", "msg"} problems, as the registry sends a lego's)."""
    try:
        body = response.json()
        if isinstance(body, dict) and isinstance(body.get("detail"), list):
            return "; ".join(problem_text(p) for p in body["detail"]) or f"{name} answered {response.status_code}"
        return str(body.get("description") or body.get("detail") or body["error"])
    except (ValueError, KeyError, TypeError, AttributeError):
        return f"{name} answered {response.status_code}"


def problem_text(problem) -> str:
    if not isinstance(problem, dict):
        return str(problem)
    where = ".".join(str(part) for part in problem.get("loc") or [] if part != "body")
    return f"{where}: {problem.get('msg')}" if where else str(problem.get("msg"))
