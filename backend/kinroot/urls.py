"""URL map. Every API route lives under /api/v1 (see docs/API_CONTRACT.md); probes live at the root."""

from django.urls import include, path, re_path

from kinroot.core import errors, health
from kinroot.core.metrics import metrics_view

urlpatterns = [
    path("health", health.health),
    path("health/ready", health.ready),
    path("metrics", metrics_view),
    path("api/v1/", include("api.urls")),
    # Unknown API paths are problem+json even with DEBUG on (must stay last).
    re_path(r"^api/", errors.handler404),
]

handler404 = "kinroot.core.errors.handler404"
handler500 = "kinroot.core.errors.handler500"
