from django.apps import AppConfig


class AccountsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "accounts"
    verbose_name = "Accounts"

    def ready(self) -> None:
        # Demo clock (kinroot/clock.py): replay the sample firm as of a fixed day when KINROOT_DEMO_TODAY is set.
        from django.conf import settings

        from kinroot import clock

        demo_today = settings.KINROOT.get("DEMO_TODAY")
        if demo_today:
            clock.install(str(demo_today))
