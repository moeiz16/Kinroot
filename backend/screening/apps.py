from django.apps import AppConfig


class ScreeningConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "screening"
    verbose_name = "Screening"

    def ready(self) -> None:
        from jobs import api as jobs

        @jobs.register("screening.client", max_attempts=3, timeout_s=300)
        def screen_client_job(payload: dict) -> dict:
            from graph.common import system_actor

            from . import service

            r = service.screen_client(
                payload["orgId"],
                payload["clientId"],
                system_actor(payload["orgId"]),
                reason=payload.get("reason", "onboarding"),
            )
            return {"runId": r.run_id, "newHits": r.new_hits, "screenedParties": r.screened_parties}

        @jobs.register("screening.rescreen_org", max_attempts=3, timeout_s=1800)
        def rescreen_org_job(payload: dict) -> dict:
            from graph.common import system_actor

            from . import service

            r = service.screen_org(
                payload["orgId"], system_actor(payload["orgId"]), reason=payload.get("reason", "list_update")
            )
            return {"runId": r.run_id, "newHits": r.new_hits, "screenedParties": r.screened_parties}

        @jobs.register("screening.load_lists", max_attempts=2, timeout_s=1800)
        def load_lists_job(payload: dict) -> dict:
            from . import service

            return {"versions": service.load_lists(source=payload.get("source"))}
