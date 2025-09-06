from django.apps import AppConfig


class ClientsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "clients"
    verbose_name = "Clients"

    def ready(self) -> None:
        from clients import jobs, signals

        signals.connect()
        jobs.register_all()
