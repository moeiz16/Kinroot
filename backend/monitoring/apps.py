from django.apps import AppConfig


class MonitoringConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "monitoring"
    verbose_name = "Ongoing monitoring"

    def ready(self) -> None:
        from jobs import api as jobs

        @jobs.register("monitoring.daily", max_attempts=3, timeout_s=1800)
        def daily_job(payload: dict) -> dict:
            from . import service

            return service.run_daily(payload["orgId"])

        @jobs.register("monitoring.structure_changed", max_attempts=3, timeout_s=300)
        def structure_changed_job(payload: dict) -> dict:
            from . import service

            return {
                "alerts": service.on_structure_changed(
                    payload["orgId"], payload.get("clientIds", []), payload.get("edgeIds", [])
                )
            }
