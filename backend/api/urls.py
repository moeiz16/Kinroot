"""/api/v1 URL map. Builder A adds one module per area under api/views/ and registers it here."""

from django.urls import path

from kinroot.core import health

urlpatterns = [
    path("health", health.health),
]
