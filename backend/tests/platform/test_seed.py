"""The demo seed (contract Part 5) loads the platform data even while domain modules are unavailable."""

from __future__ import annotations

import pytest

from accounts.models import Membership, Organisation, User
from audit import api as audit
from cases.models import Case, CaseAccess, Concern
from clients.models import Client, ClientHold, Party
from clients.seed import Seeder

pytestmark = pytest.mark.django_db


@pytest.fixture
def seeded(settings):
    settings.PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
    return Seeder(out=lambda _msg: None).run()


def test_seed_creates_both_firms(seeded):
    hl = Organisation.objects.get(slug="harbourline-legal")
    ng = Organisation.objects.get(slug="northgate-accountants")
    assert Client.objects.filter(org=hl).count() == 30
    assert Client.objects.filter(org=ng).count() == 4
    assert Party.objects.filter(org=hl).count() >= 120
    assert Membership.objects.filter(org=hl).count() == 6
    assert not Membership.objects.filter(org=ng, user__email__endswith="harbourline.example").exists()


def test_seed_is_idempotent(seeded):
    again = Seeder(out=lambda _msg: None).run()
    assert again["harbourline"] is False
    assert again["northgate"] is False
    assert Organisation.objects.count() == 2


def test_seed_audit_chain_is_valid(seeded):
    hl = Organisation.objects.get(slug="harbourline-legal")
    result = audit.verify_chain(hl.id)
    assert result["valid"] is True
    assert result["checked"] >= 150


def test_seed_statuses_and_relative_dates(seeded):
    hl = Organisation.objects.get(slug="harbourline-legal")
    statuses = dict(Client.objects.filter(org=hl).values_list("seed_key", "status"))
    assert statuses["lim-family"] == "onboarding"
    assert statuses["coastal-conveyancing"] == "exited"
    assert statuses["whitfield-julian"] == "onboarding"
    patel = Client.objects.get(org=hl, seed_key="patel-riya")
    from django.utils import timezone

    assert (timezone.localdate() - patel.next_review_on).days == 40


def test_seed_case_access_and_hold(seeded):
    hl = Organisation.objects.get(slug="harbourline-legal")
    case = Case.objects.get(org=hl)
    levels = {a.user.email: a.level for a in CaseAccess.objects.filter(case=case)}
    assert levels == {"daniel@harbourline.example": "full", "margaret@harbourline.example": "summary"}
    assert ClientHold.objects.filter(client=case.client, released_at__isnull=True).exists()
    assert Concern.objects.get(org=hl).raised_by.email == "tom@harbourline.example"


def test_demo_password_works(seeded):
    from django.contrib.auth.hashers import check_password

    user = User.objects.get(email="olivia@harbourline.example")
    assert check_password("Kinroot-demo-2025!", user.password)
