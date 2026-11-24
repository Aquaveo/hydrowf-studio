"""What a failed Keycloak refresh means: log in again (Unauthorized) or try again later (Unavailable)."""
import pytest
import requests
from social_core import exceptions as social_errors
from social_core.exceptions import AuthException

from tethysapp.hydrowf_studio.service import Unauthorized, Unavailable
from tethysapp.hydrowf_studio.tokens import refreshed


class Social:
    """A social-auth row: get_access_token answers `access` or raises `error`."""

    def __init__(self, access="access-1", error=None):
        self.access, self.error, self.strategies = access, error, []

    def get_access_token(self, strategy):
        self.strategies.append(strategy)
        if self.error:
            raise self.error
        return self.access


def http_error(status):
    response = requests.Response()
    response.status_code = status
    return requests.HTTPError(f"{status} from keycloak", response=response)


def test_a_token_is_refreshed_with_the_portals_strategy():
    social = Social()
    assert refreshed(social, lambda: "strategy") == "access-1"
    assert social.strategies == ["strategy"]


def version_errors():
    """The errors only one social-auth-core version raises: 5.x's AuthConnectionError, 7.x's coded
    AuthProviderError."""
    if hasattr(social_errors, "AuthConnectionError"):
        yield social_errors.AuthConnectionError(None, "keycloak unreachable"), Unavailable
    if hasattr(social_errors, "AuthProviderError"):
        for code in ("connection_failed", "timeout", "tls_error", "unavailable", "rate_limited"):
            yield social_errors.AuthProviderError(None, code=code), Unavailable
        yield social_errors.AuthProviderError(None, code="http_error", status_code=400), Unauthorized


@pytest.mark.parametrize("error, expected", [
    (http_error(400), Unauthorized),                         # invalid_grant: the refresh token is over
    (http_error(401), Unauthorized),
    (http_error(500), Unavailable),                          # Keycloak's trouble, not the user's login
    (http_error(503), Unavailable),
    (requests.HTTPError("no response"), Unauthorized),
    (requests.ConnectionError("refused"), Unavailable),
    (requests.ReadTimeout("slow"), Unavailable),
    (AuthException(None, "denied"), Unauthorized),
    *version_errors(),
])
def test_a_failed_refresh_says_whether_to_log_in_again_or_wait(error, expected):
    with pytest.raises(expected) as err:
        refreshed(Social(error=error), lambda: None)
    assert err.value.__cause__ is None                       # nothing from the refresh rides along


@pytest.mark.parametrize("access", ["", None])
def test_no_token_means_logging_in_again(access):
    with pytest.raises(Unauthorized):
        refreshed(Social(access=access), lambda: None)
