from django.apps import AppConfig


class ResolutionConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "resolution"
    verbose_name = "Entity resolution"

    def ready(self) -> None:
        from jobs import api as jobs

        @jobs.register("resolution.find_candidates", max_attempts=3, timeout_s=600)
        def find_candidates_job(payload: dict) -> dict:
            from . import service

            ids = payload.get("partyIds")
            return {"candidates": service.find_candidates(payload["orgId"], party_ids=ids)}
