"""ASGI entry point (uvicorn). ASGI is required for the streaming SSE endpoint."""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "kinroot.settings")
application = get_asgi_application()
