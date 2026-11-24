"""A client for hydrowf-registry as the user: the legos they may see (public ones and their own) and
publishing their pipelines. Answers are the registry's JSON. Errors: see service.py; a lego the registry
refuses is Refused with its problems as the reason (422), 409 for a version that exists, 403 for an id
that's someone else's."""
from .service import Refused, ServiceClient, part

KINDS = ("tool", "data", "pipeline")


class RegistryClient(ServiceClient):
    name = "the registry"

    def legos(self, kind: str | None = None) -> list[dict]:
        """The legos the user may see, by id then version (oldest first); only `kind`'s with a kind."""
        if kind is not None and kind not in KINDS:
            raise Refused(400, f"kind is one of {', '.join(KINDS)}")
        return self._list("GET", "/legos", params={"kind": kind} if kind else None)

    def lego(self, lego_id: str, version: str) -> dict:
        return self._dict("GET", f"/legos/{part(lego_id)}/{part(version)}")

    def publish(self, lego: dict) -> dict:
        """Publish one lego version as the user: the lego as stored (its owner is the user)."""
        return self._dict("POST", "/legos", json=lego)
