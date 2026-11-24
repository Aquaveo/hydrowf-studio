"""The studio's JSON API without Tethys: what each failure becomes for the browser, and the bodies it takes."""
from contextlib import contextmanager

import pytest

from tethysapp.hydrowf_studio import api
from tethysapp.hydrowf_studio.service import OutcomeUnknown, Refused, ServiceError, Unauthorized, Unavailable


def failing(error):
    def call():
        raise error
    return call


@pytest.mark.parametrize("error, status, extra", [
    (api.BadRequest("the body isn't JSON"), 400, {}),
    (Unauthorized("your login has expired: log in again"), 401, {}),
    (Refused(409, "my-flow@0.1.0 exists"), 409, {}),
    (Refused(422, "steps.0.tool: no tool"), 422, {}),
    (Unavailable("/ogc can't answer right now (503)"), 503, {}),
    (OutcomeUnknown("/ogc failed (500): it may have done it anyway; check first"), 502, {"outcome": "unknown"}),
    (ServiceError("/ogc answered 200 with something that isn't JSON"), 502, {}),
])
def test_each_failure_becomes_a_status_and_its_message(error, status, extra):
    assert api.answer(failing(error)) == (status, {"error": str(error), **extra})


def test_a_success_is_its_result_with_the_given_status():
    assert api.answer(lambda: {"jobID": "j"}, ok=201) == (201, {"jobID": "j"})


def test_anything_else_is_left_to_the_portal():
    with pytest.raises(KeyError):                      # a bug: logged and a 500 by Django, never hidden
        api.answer(failing(KeyError("x")))


@pytest.mark.parametrize("raw", [b"", b"not json", b"\xff", b"[]", b'"x"', b'{"inputs": []}',
                                 b'{"inputs": {}, "x": 1}'])
def test_an_execute_body_is_inputs_only(raw):
    with pytest.raises(api.BadRequest):
        api.inputs_body(raw)


def test_an_execute_body_gives_its_inputs():
    assert api.inputs_body(b'{"inputs": {"feature": "gage-01031510"}}') == {"feature": "gage-01031510"}


@pytest.mark.parametrize("raw", [b"", b"[]", b"3", b"{"])
def test_a_lego_to_publish_is_an_object(raw):
    with pytest.raises(api.BadRequest):
        api.lego_body(raw)


class Recorder:
    """Both clients in one: records each call, answers what the test set."""

    def __init__(self, **answers):
        self.calls, self.answers = [], answers

    def __getattr__(self, name):
        def call(*args):
            self.calls.append((name, *args))
            return self.answers.get(name)
        return call


def test_the_calls_reach_the_right_service():
    ogc, registry = Recorder(execute={"jobID": "j"}), Recorder(publish={"id": "my-flow"})
    clients = api.Clients(ogc, registry)
    assert api.run(clients, "my-flow@0.1.0", b'{"inputs": {"a": 1}}') == {"jobID": "j"}
    assert api.publish(clients, b'{"id": "my-flow"}') == {"id": "my-flow"}
    assert api.dismiss(clients, "j") == {"jobID": "j", "status": "dismissed"}
    api.legos(clients, "")
    assert ogc.calls == [("execute", "my-flow@0.1.0", {"a": 1}), ("dismiss", "j")]
    assert registry.calls == [("publish", {"id": "my-flow"}), ("legos", None)]


# ---- respond: one api/ request

LOGIN = "/oauth2/login/keycloak/?next=/apps/hydrowf-studio/"


class Opened:
    """open_clients for respond: records whether the user's clients were opened."""

    def __init__(self):
        self.count = 0

    @contextmanager
    def __call__(self):
        self.count += 1
        yield "clients"


def test_a_method_the_route_doesnt_take_is_405_with_allow():
    opened = Opened()
    assert api.respond("PUT", {"GET": len, "DELETE": len}, True, opened, LOGIN) == (
        405, {"error": "use GET or DELETE"}, {"Allow": "GET, DELETE"})
    assert opened.count == 0


def test_a_user_who_isnt_logged_in_gets_401_with_the_login_url_and_nothing_is_called():
    opened = Opened()
    assert api.respond("GET", {"GET": len}, False, opened, LOGIN) == (
        401, {"error": "log in to use the studio", "login": LOGIN}, {})
    assert opened.count == 0


def test_a_login_that_is_over_gets_the_login_url_too():
    expired = failing(Unauthorized("your login has expired: log in again"))
    status, body, _ = api.respond("GET", {"GET": lambda c: expired()},
                                  True, Opened(), LOGIN)
    assert (status, body) == (401, {"error": "your login has expired: log in again", "login": LOGIN})


@pytest.mark.parametrize("method, status", [("POST", 201), ("GET", 200), ("DELETE", 200)])
def test_only_a_post_answers_with_the_routes_created_status(method, status):
    assert api.respond(method, {method: lambda c: {"got": c}}, True, Opened(), LOGIN, ok=201) == (
        status, {"got": "clients"}, {})
