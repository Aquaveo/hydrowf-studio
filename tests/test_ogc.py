"""The /ogc client against a fake /ogc over real HTTP. The fake answers with the shapes hydrowf-ogc sends:
pygeoapi's execute statusInfo, job records and exception bodies, hydrowf-ogc's own {"error"} bodies, its
result links and job steps; a dismissed job is deleted, so it's then unknown (404). The error handling is
service.py's, shared with the registry client."""
import socket

import pytest
import requests
from fake_http import serving
from urllib3.exceptions import MaxRetryError, SSLError as TLSError

from tethysapp.hydrowf_studio.ogc import OgcClient
from tethysapp.hydrowf_studio.service import OutcomeUnknown, Refused, ServiceError, Unauthorized, Unavailable

TOKEN = "token-1"
CNG = "s3://hydrowf/job-1/cng/"


class FakeOgc:
    """/ogc in memory: one process, jobs that start accepted, results set by the test."""

    def __init__(self):
        self.jobs, self.results, self.requests = {}, {}, []
        self.answer = None                  # (status, body, content type): the next answer, whatever the route

    def handle(self, method, path, headers, body):
        self.requests.append({"method": method, "path": path, "headers": headers, "body": body})
        if headers.get("Authorization") != f"Bearer {TOKEN}":
            return 401, {"error": "invalid token"}
        if self.answer:
            answer, self.answer = self.answer, None
            return answer
        parts = path.split("?")[0].strip("/").split("/")[1:]          # after "ogc"
        if parts == ["processes"]:
            return 200, {"processes": [{"id": "ngiab-rerun", "version": "0.1.0"}], "links": []}
        if parts == ["processes", "ngiab-rerun"]:
            return 200, {"id": "ngiab-rerun", "inputs": {"cng": {}}, "outputs": {"cng": {}}}
        if parts == ["jobs"]:
            return 200, {"jobs": [{"jobID": job_id, "status": status} for job_id, status in self.jobs.items()],
                         "links": []}
        if parts == ["processes", "ngiab-rerun", "execution"] and method == "POST":
            job_id = f"job-{len(self.requests)}"
            self.jobs[job_id] = "accepted"
            return 201, {"jobID": job_id, "type": "process", "status": "accepted"}
        if len(parts) >= 2 and parts[0] == "jobs" and parts[1] in self.jobs:
            job_id = parts[1]
            if parts[2:] == ["results"] and job_id in self.results:
                return 200, self.results[job_id]
            if parts[2:] == ["results"]:
                return 404, {"code": "ResultNotReady", "description": "job results not ready"}
            if parts[2:] == ["steps"]:
                return 200, {"jobID": job_id, "steps": {"sim": "successful", "rerun": "running"}}
            if method == "DELETE":
                del self.jobs[job_id]                   # hydrowf-ogc deletes the workflow, outputs included
                return 200, {"jobID": job_id, "status": "dismissed"}
            return 200, {"type": "process", "processID": "ngiab-rerun", "jobID": job_id,
                         "status": self.jobs[job_id], "message": "", "progress": 5}
        return 404, {"code": "InvalidParameterValue", "type": "InvalidParameterValue", "description": parts[-1]}


@pytest.fixture
def ogc():
    fake = FakeOgc()
    with serving(fake.handle) as url:
        fake.url = url + "/ogc"
        yield fake


@pytest.fixture
def client(ogc):
    with OgcClient(ogc.url, lambda: TOKEN, timeout=5) as client:
        yield client


def closed_port() -> int:
    with socket.socket() as s:                      # bound then closed: nothing listens there
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(client) -> str:
    return client.execute("ngiab-rerun", {"cng": CNG})["jobID"]


# ---- what the studio uses

def test_it_describes_a_process(client):
    assert list(client.describe("ngiab-rerun")["inputs"]) == ["cng"]


def test_every_request_asks_for_json_with_the_token(client, ogc):
    client.describe("ngiab-rerun")
    request = ogc.requests[-1]
    assert request["path"].endswith("?f=json")
    assert request["headers"]["Accept"] == "application/json"
    assert request["headers"]["Authorization"] == f"Bearer {TOKEN}"


def test_execute_starts_an_async_job_with_the_inputs(client, ogc):
    status_info = client.execute("ngiab-rerun", {"cng": CNG})
    request = ogc.requests[-1]
    assert status_info["status"] == "accepted" and status_info["jobID"] in ogc.jobs
    assert request["headers"]["Prefer"] == "respond-async"
    assert request["body"] == {"inputs": {"cng": CNG}}


def test_a_job_is_ogcs_record_and_jobs_list_them(client, ogc):
    job_id = start(client)
    assert client.job(job_id) == {"type": "process", "processID": "ngiab-rerun", "jobID": job_id,
                                  "status": "accepted", "message": "", "progress": 5}
    assert client.jobs() == [{"jobID": job_id, "status": "accepted"}]


def test_steps_are_each_steps_status(client):
    assert client.steps(start(client))["steps"] == {"sim": "successful", "rerun": "running"}


def test_a_dismissed_job_is_gone(client, ogc):
    job_id = start(client)
    client.dismiss(job_id)
    with pytest.raises(Refused) as err:
        client.job(job_id)
    assert err.value.status == 404


@pytest.mark.parametrize("link", [
    {"href": CNG},                                                          # no presigner
    {"href": "https://s3.example/x.tgz?sig=1", "type": "application/gzip", "s3": CNG},   # presigned file
    {"s3": CNG, "type": "inode/directory", "truncated": False, "files": []},            # presigned directory
])
def test_results_are_ogcs_links_as_they_are(client, ogc, link):
    job_id = start(client)
    ogc.results[job_id] = {"cng": link}
    assert client.results(job_id) == {"cng": link}


def test_results_before_success_are_refused(client):
    job_id = start(client)
    with pytest.raises(Refused, match="not ready"):
        client.results(job_id)


@pytest.mark.parametrize("job_id", ["", ".", ".."])
def test_an_id_that_would_name_another_route_is_refused_unsent(client, ogc, job_id):
    with pytest.raises(Refused):
        client.job(job_id)
    assert ogc.requests == []


def test_a_callers_session_is_left_open():
    session = requests.Session()
    OgcClient("http://ogc.example/ogc", lambda: TOKEN, session=session).close()
    assert session.adapters                           # Session.close() clears them


def test_ids_are_escaped_in_the_path(client, ogc):
    with pytest.raises(Refused):
        client.job("../processes")
    assert ogc.requests[-1]["path"].startswith("/ogc/jobs/..%2Fprocesses?")


# ---- tokens

def test_the_token_is_asked_for_on_every_request(ogc):
    tokens = iter(["stale", TOKEN])                  # a refreshed token is used without a new client
    client = OgcClient(ogc.url, lambda: next(tokens), timeout=5)
    with pytest.raises(Unauthorized, match="log in again") as err:
        client.jobs()
    assert "stale" not in str(err.value)
    assert client.jobs() == []


@pytest.mark.parametrize("token", ["", "secret-tok\n", " secret-tok", "secret tok", "secret\x00tok", "secret\u2019tok",
                                   b"secret-tok"])
def test_an_unusable_token_is_unauthorized_and_never_shown(ogc, token):
    with pytest.raises(Unauthorized) as err:
        OgcClient(ogc.url, lambda: token, timeout=5).jobs()
    assert "secret" not in str(err.value) and err.value.__cause__ is None
    assert ogc.requests == []                         # refused before anything was sent


# ---- answers that aren't a yes

@pytest.mark.parametrize("status, body, text", [
    (400, {"code": "InvalidParameterValue", "description": "input baseline: 'nope' is not one of ['none']"},
     "input baseline: 'nope'"),
    (403, {"code": "Forbidden", "description": "input cng: not found"}, "input cng: not found"),   # ForbiddenInput
    (413, {"error": "the body is over 1048576 bytes"}, "the body is over"),                        # hydrowf-ogc's own
])
def test_a_refusal_carries_ogcs_reason(client, ogc, status, body, text):
    ogc.answer = (status, body)
    with pytest.raises(Refused, match=text) as err:
        client.execute("ngiab-rerun", {"cng": CNG})
    assert err.value.status == status


def test_an_unknown_job_is_refused_with_404(client):
    with pytest.raises(Refused) as err:
        client.job("no-such-job")
    assert err.value.status == 404


def test_a_refusal_without_a_reason_says_the_status(client, ogc):
    ogc.answer = (404, "<html>Not Found</html>", "text/html")
    with pytest.raises(Refused, match="/ogc answered 404"):
        client.jobs()


@pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
def test_a_read_without_a_usable_answer_is_unavailable(client, ogc, status):
    ogc.answer = (status, {"error": "internal error"})
    with pytest.raises(Unavailable):
        client.job("job-1")


@pytest.mark.parametrize("status", [500, 502, 504])
def test_an_execute_failing_after_it_was_sent_has_an_unknown_outcome(client, ogc, status):
    ogc.answer = (status, {"error": "internal error"})
    with pytest.raises(OutcomeUnknown, match="may have done it anyway"):
        client.execute("ngiab-rerun", {"cng": CNG})


@pytest.mark.parametrize("status", [408, 429])
def test_an_execute_turned_away_unread_is_unavailable(client, ogc, status):
    ogc.answer = (status, {"error": "slow down"})
    with pytest.raises(Unavailable):
        client.execute("ngiab-rerun", {"cng": CNG})


def test_an_execute_that_timed_out_waiting_for_an_answer_has_an_unknown_outcome():
    class SlowOgc(requests.Session):                  # sent, then no answer in time
        def request(self, *args, **kwargs):
            raise requests.ReadTimeout("read timed out")

    with pytest.raises(OutcomeUnknown):
        OgcClient("http://ogc.example/ogc", lambda: TOKEN, session=SlowOgc()).execute("ngiab-rerun", {})


def failing(error):
    class Failing(requests.Session):
        def request(self, *args, **kwargs):
            raise error
    return OgcClient("http://ogc.example/ogc", lambda: TOKEN, session=Failing())


def test_an_execute_whose_connection_dropped_after_sending_has_an_unknown_outcome():
    with pytest.raises(OutcomeUnknown):
        failing(requests.ConnectionError("connection reset by peer")).execute("ngiab-rerun", {})


def test_a_read_that_timed_out_is_unavailable():
    with pytest.raises(Unavailable):
        failing(requests.ReadTimeout("read timed out")).job("job-1")


def test_an_unreachable_ogc_is_unavailable_even_for_execute():
    client = OgcClient(f"http://127.0.0.1:{closed_port()}/ogc", lambda: TOKEN, timeout=2)
    with pytest.raises(Unavailable, match="can't be reached"):
        client.jobs()
    with pytest.raises(Unavailable, match="can't be reached"):     # never sent: nothing started
        client.execute("ngiab-rerun", {"cng": CNG})


@pytest.mark.parametrize("answer", [(200, "<html>log in</html>", "text/html"),    # e.g. a proxy's login page
                                    (200, ["not", "a", "dict"]),
                                    (200, "3")])
def test_an_answer_that_isnt_ogcs_is_an_error(client, ogc, answer):
    ogc.answer = answer
    with pytest.raises(ServiceError):
        client.execute("ngiab-rerun", {"cng": CNG})


def test_a_list_without_its_key_is_an_error(client, ogc):
    ogc.answer = (200, {"links": []})
    with pytest.raises(ServiceError, match="no jobs list"):
        client.jobs()


@pytest.mark.parametrize("status", [500, 502])
def test_a_dismiss_failing_after_it_was_sent_has_an_unknown_outcome(client, ogc, status):
    ogc.answer = (status, {"error": "internal error"})
    with pytest.raises(OutcomeUnknown):
        client.dismiss("job-1")


def test_a_redirect_is_not_followed(client, ogc):
    ogc.answer = (302, "", "text/plain", {"Location": ogc.url + "/jobs"})      # followed, it'd be a 200 list
    with pytest.raises(ServiceError, match="a redirect"):
        client.execute("ngiab-rerun", {"cng": CNG})
    assert len(ogc.requests) == 1


def test_a_failed_tls_handshake_sent_nothing():
    handshake = MaxRetryError(None, "/ogc", reason=TLSError("handshake failure"))
    with pytest.raises(Unavailable):
        failing(requests.exceptions.SSLError(handshake)).execute("ngiab-rerun", {})


def test_a_tls_failure_while_reading_the_answer_has_an_unknown_outcome():
    with pytest.raises(OutcomeUnknown):
        failing(requests.exceptions.SSLError(TLSError("bad record mac"))).execute("ngiab-rerun", {})
