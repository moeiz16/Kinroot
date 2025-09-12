"""Platform test fixtures (reuse the API builders)."""

from __future__ import annotations

from typing import Any

import pytest

from tests.api.helpers import make_firm


@pytest.fixture(autouse=True)
def _fast_passwords(settings: Any) -> None:
    settings.PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]


@pytest.fixture
def firm(db: Any) -> dict[str, Any]:
    return make_firm("Harbourline Legal", "AU", domain="harbourline.test")


@pytest.fixture
def other_firm(db: Any) -> dict[str, Any]:
    return make_firm("Northgate Accountants", "GB", domain="northgate.test")
