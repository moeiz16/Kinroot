"""ASGI entry point (uvicorn). ASGI is required for the streaming SSE endpoint."""

import logging
import os
import threading

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "kinroot.settings")
application = get_asgi_application()


def _warm_model_registry() -> None:
    """Look up the registered model versions once at start-up (MLflow's first import and query take about a
    second), so the first person to open Settings → Risk method does not wait for it."""
    try:
        from risk import service

        for name, version in service.registered_versions():
            service._run_id(name, version)
    except Exception:  # never block start-up on the optional registry
        logging.getLogger(__name__).debug("model registry warm-up skipped", exc_info=True)


threading.Thread(target=_warm_model_registry, name="warm-model-registry", daemon=True).start()
