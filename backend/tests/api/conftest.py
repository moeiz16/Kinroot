"""API test fixtures: firms, members per role, signed-in clients with CSRF, and B-domain fakes."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from rest_framework.test import APIClient

from tests.api.helpers import make_client_record, make_firm, signed_in


@pytest.fixture(autouse=True)
def _fast_passwords(settings: Any) -> None:
    settings.PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]


@pytest.fixture(autouse=True)
def _no_throttle_bleed() -> None:
    from django.core.cache import cache

    cache.clear()


@pytest.fixture
def firm(db: Any) -> dict[str, Any]:
    return make_firm("Harbourline Legal", "AU", domain="harbourline.test")


@pytest.fixture
def other_firm(db: Any) -> dict[str, Any]:
    return make_firm("Northgate Accountants", "GB", domain="northgate.test")


@pytest.fixture
def as_role(firm: dict[str, Any]) -> Callable[[str], APIClient]:
    def _as(role: str) -> APIClient:
        return signed_in(firm["users"][role])

    return _as


@pytest.fixture
def client_record(firm: dict[str, Any]) -> Any:
    return make_client_record(firm, "Bellmere Holdings Pty Ltd", kind="company")


@pytest.fixture
def no_domain(monkeypatch: Any) -> None:
    """Make the domain core look unavailable so platform behaviour is tested on its own."""
    from graph import api as graph_api
    from screening import api as screening_api

    def unavailable(*_a: Any, **_k: Any) -> Any:
        raise NotImplementedError

    monkeypatch.setattr(graph_api, "beneficial_owners", unavailable)
    monkeypatch.setattr(screening_api, "list_hits", unavailable)
