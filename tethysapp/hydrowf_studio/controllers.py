"""The studio page and its JSON API (api.py), as the logged-in user. Nothing is stored here.

The api/ routes answer JSON only: Tethys' login redirect is off for them (login_required=False), and
api.respond answers 401 with the login URL instead, which the page can follow.
"""
from django.http import JsonResponse
from django.urls import reverse
from django.views.decorators.csrf import ensure_csrf_cookie
from tethys_sdk.routing import controller

from . import api
from .app import App
from .tokens import PROVIDER, token_for

PROCESS_ID = r"[0-9A-Za-z._-]+(?:@[0-9A-Za-z._-]+)?"    # <id> or <id>@<version>: Tethys' default has no @


@controller(ensure_oauth2_provider=PROVIDER)
@ensure_csrf_cookie                                      # the page's POST and DELETE send it back (X-CSRFToken)
def home(request):
    """The studio page: the editor talks to the api/ routes below."""
    return App.render(request, "index.html", {"poll_seconds": App.get_custom_setting("poll_seconds")})


def respond(request, methods: dict, ok: int = 200) -> JsonResponse:
    """Run methods[request.method](clients) as the user and answer with JSON (api.respond)."""
    def open_clients():
        return api.clients(App.get_custom_setting("ogc_url"), App.get_custom_setting("registry_url"),
                           token_for(request.user))

    login = reverse("social:begin", args=[PROVIDER]) + "?next=" + reverse("hydrowf_studio:home")
    status, body, headers = api.respond(request.method, methods, request.user.is_authenticated, open_clients,
                                        login, ok)
    response = JsonResponse(body, status=status, safe=False)
    for key, value in headers.items():
        response[key] = value
    return response


@controller(url="api/legos", login_required=False)
def legos(request):
    return respond(request, {"GET": lambda c: api.legos(c, request.GET.get("kind")),
                             "POST": lambda c: api.publish(c, request.body)}, ok=201)


@controller(url="api/legos/{lego_id}/{version}", login_required=False)
def lego(request, lego_id, version):
    return respond(request, {"GET": lambda c: api.lego(c, lego_id, version)})


@controller(url="api/processes/{process_id}", regex=PROCESS_ID, login_required=False)
def process(request, process_id):
    return respond(request, {"GET": lambda c: api.process(c, process_id)})


@controller(url="api/processes/{process_id}/execution", regex=PROCESS_ID, login_required=False)
def run(request, process_id):
    return respond(request, {"POST": lambda c: api.run(c, process_id, request.body)}, ok=201)


@controller(url="api/jobs", login_required=False)
def jobs(request):
    return respond(request, {"GET": api.jobs})


@controller(url="api/jobs/{job_id}", login_required=False)
def job(request, job_id):
    return respond(request, {"GET": lambda c: api.job(c, job_id), "DELETE": lambda c: api.dismiss(c, job_id)})


@controller(url="api/jobs/{job_id}/steps", login_required=False)
def job_steps(request, job_id):
    return respond(request, {"GET": lambda c: api.steps(c, job_id)})


@controller(url="api/jobs/{job_id}/results", login_required=False)
def job_results(request, job_id):
    return respond(request, {"GET": lambda c: api.results(c, job_id)})
