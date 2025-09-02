"""WSGI entry point (management tooling only; serve the API with ASGI)."""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "kinroot.settings")
application = get_wsgi_application()
