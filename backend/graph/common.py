"""Small helpers the domain-core apps share for calling the platform (audit, events, users, settings)."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from kinroot.contracts import Actor

log = logging.getLogger(__name__)


def kinroot_setting(key: str, default: Any = None) -> Any:
    """Typed access to settings.KINROOT (django-stubs types unknown settings as object)."""
    from django.conf import settings

    cfg: dict[str, Any] = settings.KINROOT
    return cfg.get(key, default)


def system_actor(org_id: Any) -> Actor:
    return Actor(org_id=uuid.UUID(str(org_id)), user_id=None, name="System")


def audit(actor: Actor, action: str, **kwargs: Any) -> None:
    from audit import api as audit_api

    audit_api.record(actor, action, **kwargs)


def publish(org_id: Any, event: str, data: dict[str, Any], *, permission: str | None = None) -> None:
    try:
        from jobs import api as jobs

        jobs.publish_event(uuid.UUID(str(org_id)), event, data, permission=permission)
    except Exception:  # events are best effort; the state change has already committed
        log.debug("publish %s failed", event, exc_info=True)


def enqueue(
    kind: str, payload: dict[str, Any], *, org_id: Any, dedupe_key: str | None = None, priority: int = 100
) -> Any:
    from jobs import api as jobs

    return jobs.enqueue(
        kind, {"orgId": str(org_id), **payload}, org_id=uuid.UUID(str(org_id)), dedupe_key=dedupe_key, priority=priority
    )


def user_names(user_ids: set[Any]) -> dict[str, str]:
    from accounts.models import User

    ids = [u for u in user_ids if u]
    return {str(u.id): u.full_name for u in User.objects.filter(id__in=ids).only("id", "full_name")}


def user_name(user_id: Any) -> str | None:
    if not user_id:
        return None
    return user_names({user_id}).get(str(user_id))


def org_settings(org_id: Any) -> dict[str, Any]:
    try:
        from accounts.services import org_settings as _settings

        return _settings(org_id)
    except Exception:
        from accounts.services import default_settings

        return default_settings()


def as_uuid(value: Any) -> uuid.UUID:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        from kinroot.contracts import NotFound

        raise NotFound("id") from exc
