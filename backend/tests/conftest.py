"""Shared fixtures."""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient


@pytest.fixture
def api() -> APIClient:
    return APIClient(enforce_csrf_checks=True)
