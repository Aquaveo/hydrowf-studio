"""The registry client against a fake hydrowf-registry over real HTTP, answering as its FastAPI app does:
lists of legos, {"detail": <text>} refusals, and {"detail": [{"loc", "msg"}]} for a lego it won't take."""
import pytest
from fake_http import serving

from tethysapp.hydrowf_studio.registry import RegistryClient
from tethysapp.hydrowf_studio.service import OutcomeUnknown, Refused, ServiceError, Unauthorized

TOKEN = "token-1"
TOOL = {"kind": "tool", "id": "ngiab-run", "version": "0.1.0", "visibility": "public"}
FLOW = {"kind": "pipeline", "id": "my-flow", "version": "0.1.0", "visibility": "owner"}


class FakeRegistry:
    def __init__(self):
        self.legos, self.requests = [TOOL], []
        self.answer = None

    def handle(self, method, path, headers, body):
        self.requests.append({"method": method, "path": path, "headers": headers, "body": body})
        if headers.get("Authorization") != f"Bearer {TOKEN}":
            return 401, {"detail": "Invalid bearer token"}
        if self.answer:
            answer, self.answer = self.answer, None
            return answer
        route, _, query = path.partition("?")
        parts = route.strip("/").split("/")
        if parts == ["legos"] and method == "POST":
            if any((x["id"], x["version"]) == (body["id"], body["version"]) for x in self.legos):
                return 409, {"detail": f"{body['id']}@{body['version']} exists: versions are immutable"}
            self.legos.append({**body, "owner": "me"})
            return 201, self.legos[-1]
        if parts == ["legos"]:
            kind = dict(p.split("=") for p in query.split("&") if p).get("kind")
            return 200, [x for x in self.legos if kind in (None, x["kind"])]
        if parts[0] == "legos" and len(parts) == 3:
            found = [x for x in self.legos if (x["id"], x["version"]) == (parts[1], parts[2])]
            return (200, found[0]) if found else (404, {"detail": f"no lego {parts[1]}@{parts[2]}"})
        return 404, {"detail": "Not Found"}


@pytest.fixture
def registry():
    fake = FakeRegistry()
    with serving(fake.handle) as url:
        fake.url = url
        yield fake


@pytest.fixture
def client(registry):
    with RegistryClient(registry.url, lambda: TOKEN, timeout=5) as client:
        yield client


def test_legos_are_listed_as_the_user_sees_them_by_kind(client, registry):
    client.publish(FLOW)
    assert [x["id"] for x in client.legos()] == ["ngiab-run", "my-flow"]
    assert [x["id"] for x in client.legos("pipeline")] == ["my-flow"]
    assert registry.requests[-1]["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert "f=json" not in registry.requests[-1]["path"]                 # /ogc's parameter, not the registry's


def test_a_published_lego_comes_back_as_stored(client):
    assert client.publish(FLOW)["owner"] == "me"
    assert client.lego("my-flow", "0.1.0")["owner"] == "me"


def test_publishing_a_version_again_is_refused_with_409(client):
    client.publish(FLOW)
    with pytest.raises(Refused, match="versions are immutable") as err:
        client.publish(FLOW)
    assert err.value.status == 409


def test_a_lego_the_registry_wont_take_carries_each_problem(client, registry):
    registry.answer = (422, {"detail": [{"loc": ["body", "steps", 0, "tool"], "msg": "no tool ngiab-nope@0.1.0",
                                         "type": "registry"},
                                        {"loc": ["body"], "msg": "steps form a cycle", "type": "registry"}]})
    with pytest.raises(Refused) as err:
        client.publish(FLOW)
    assert err.value.status == 422
    assert str(err.value) == "steps.0.tool: no tool ngiab-nope@0.1.0; steps form a cycle"


def test_an_unknown_kind_is_refused_unsent(client, registry):
    with pytest.raises(Refused, match="kind is one of"):
        client.legos("tools")
    assert registry.requests == []


def test_an_unknown_lego_is_404(client):
    with pytest.raises(Refused, match="no lego nope@1.0.0") as err:
        client.lego("nope", "1.0.0")
    assert err.value.status == 404


def test_a_bad_token_is_unauthorized(registry):
    with pytest.raises(Unauthorized):
        RegistryClient(registry.url, lambda: "stale", timeout=5).legos()


def test_a_publish_failing_after_it_was_sent_has_an_unknown_outcome(client, registry):
    registry.answer = (500, {"detail": "Internal Server Error"})
    with pytest.raises(OutcomeUnknown):
        client.publish(FLOW)


def test_an_object_where_a_list_belongs_is_an_error(client, registry):
    registry.answer = (200, {"legos": []})
    with pytest.raises(ServiceError, match="where a list was expected"):
        client.legos()
