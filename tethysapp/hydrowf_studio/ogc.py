"""A client for hydrowf-ogc's /ogc (OGC API - Processes) as the user: their processes (public pipelines and
their own), their jobs, each job's steps and results. Answers are /ogc's JSON, passed on as they are.
Errors: see service.py."""
from .service import ServiceClient, ServiceError, part


class OgcClient(ServiceClient):
    name = "/ogc"
    params = {"f": "json"}

    def describe(self, process_id: str) -> dict:
        return self._dict("GET", f"/processes/{part(process_id)}")

    def execute(self, process_id: str, inputs: dict) -> dict:
        """Start a job (asynchronously): /ogc's statusInfo, {"jobID", "status", ...}. OutcomeUnknown if it may
        have started anyway."""
        return self._dict("POST", f"/processes/{part(process_id)}/execution", json={"inputs": inputs},
                          headers={"Prefer": "respond-async"})

    def jobs(self) -> list[dict]:
        return listed(self._dict("GET", "/jobs"), "jobs")

    def job(self, job_id: str) -> dict:
        """{"jobID", "processID", "status", "message", "progress", ...}. A dismissed job is gone: Refused 404."""
        return self._dict("GET", f"/jobs/{part(job_id)}")

    def steps(self, job_id: str) -> dict:
        """{"jobID", "steps": {step: pending|running|successful|failed|skipped}}, in the pipeline's order."""
        return self._dict("GET", f"/jobs/{part(job_id)}/steps")

    def results(self, job_id: str) -> dict:
        """Each output's link ({"href"} and/or {"s3"}, a directory's "files"). Only for a successful job."""
        return self._dict("GET", f"/jobs/{part(job_id)}/results")

    def dismiss(self, job_id: str) -> None:
        """Stop a job and delete it, outputs included."""
        self._request("DELETE", f"/jobs/{part(job_id)}")


def listed(body: dict, key: str) -> list:
    if not isinstance(body.get(key), list):
        raise ServiceError(f"/ogc's answer has no {key} list")
    return body[key]
