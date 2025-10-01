from django.apps import AppConfig


class RiskConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "risk"
    verbose_name = "Risk"

    def ready(self) -> None:
        from jobs import api as jobs

        @jobs.register("risk.assess_client", max_attempts=3, timeout_s=300)
        def assess_client_job(payload: dict) -> dict:
            from graph.common import system_actor

            from . import service

            a = service.assess_client(payload["orgId"], payload["clientId"], system_actor(payload["orgId"]))
            return {"assessmentId": a.id, "rating": a.rating}

        @jobs.register("risk.assess_org", max_attempts=2, timeout_s=1800)
        def assess_org_job(payload: dict) -> dict:
            from graph.common import system_actor

            from . import service

            return {"assessed": service.assess_org(payload["orgId"], system_actor(payload["orgId"]))}
