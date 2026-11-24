"""The user's Keycloak access token, as the portal's social login stored it (social_django).

refreshed() decides what a failed refresh means; it needs no portal, so it's tested on its own. Two refreshes
at once with one refresh token (two api/ calls near expiry) are harmless while the realm doesn't rotate refresh
tokens ("Revoke Refresh Token" off); with rotation on, the second would log the user out.
"""
import requests
from social_core import exceptions as social_errors
from social_core.exceptions import AuthException

from .service import Unauthorized, Unavailable, sensitive_variables

PROVIDER = "keycloak"
# Keycloak couldn't answer, whatever social-auth-core's version calls it: up to 5.x an AuthConnectionError
# (other request failures are raised as they are); from 7.x an AuthProviderError with one of these codes.
NOT_REACHED = tuple(c for c in [getattr(social_errors, "AuthConnectionError", None)] if c)
WAIT_CODES = {"connection_failed", "timeout", "tls_error", "unavailable", "rate_limited"}


def token_for(user):
    """A callable giving the user's access token, refreshed when it's about to expire (social_core)."""
    def token() -> str:
        from social_django.models import UserSocialAuth     # needs a configured portal: imported when asked
        from social_django.utils import load_strategy
        social = UserSocialAuth.objects.filter(user=user, provider=PROVIDER).order_by("-pk").first()
        if social is None:
            raise Unauthorized("log in with your CIROH account to use the studio")
        return refreshed(social, load_strategy)
    return token


@sensitive_variables("access")
def refreshed(social, load_strategy) -> str:
    """social.get_access_token(), its failures as the service errors: Unauthorized when the login is over
    (Keycloak refused the refresh), Unavailable when Keycloak couldn't answer (try again later)."""
    try:
        access = social.get_access_token(load_strategy())
    except requests.HTTPError as err:            # 4xx: Keycloak refused the refresh token, the session ended
        if err.response is not None and err.response.status_code >= 500:
            raise Unavailable("the login service can't answer right now") from None
        raise Unauthorized("your login has expired: log in again") from None
    except (*NOT_REACHED, requests.RequestException):            # Keycloak not reached (or timed out)
        raise Unavailable("the login service can't be reached") from None
    except AuthException as err:
        if getattr(err, "code", None) in WAIT_CODES:             # 7.x: Keycloak's trouble, not the login's
            raise Unavailable("the login service can't answer right now") from None
        raise Unauthorized("your login has expired: log in again") from None
    if not access:
        raise Unauthorized("your login has expired: log in again")
    return access
