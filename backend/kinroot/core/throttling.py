"""Rate limits (DRF throttles on the shared cache).

`UserOrIpRateThrottle` applies the `api` rate to every request (per user when signed in, else per client IP).
Views opt into stricter scopes with `throttle_scope = "auth" | "assistant" | "upload" | "invitation"`.
Health, metrics and the SSE stream are exempt (they are not DRF views or set `throttle_classes = []`).
"""

from __future__ import annotations

from typing import Any

from rest_framework.throttling import SimpleRateThrottle

from kinroot.core.metrics import RATE_LIMITED


class UserOrIpRateThrottle(SimpleRateThrottle):
    scope = "api"

    def get_cache_key(self, request: Any, view: Any) -> str | None:
        user = getattr(request, "user", None)
        ident = f"user:{user.pk}" if user is not None and user.is_authenticated else f"ip:{self.get_ident(request)}"
        return self.cache_format % {"scope": self.scope, "ident": ident}

    def throttle_failure(self) -> bool:
        RATE_LIMITED.labels(self.scope).inc()
        return False
