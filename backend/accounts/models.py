"""Accounts: users, organisations (firms), memberships, invitations and the AML/CTF training register.

Owner: builder A. Shapes follow docs/API_CONTRACT.md Part 2.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.db import models


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def create_user(self, email: str, password: str | None = None, **extra: Any) -> User:
        if not email:
            raise ValueError("email is required")
        user = self.model(email=self.normalize_email(email).lower(), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user


class User(AbstractBaseUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=200)
    avatar_color = models.CharField(max_length=9, default="#5B6366")
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    USERNAME_FIELD = "email"
    EMAIL_FIELD = "email"
    REQUIRED_FIELDS = ["full_name"]

    objects = UserManager()

    class Meta:
        db_table = "accounts_user"

    def __str__(self) -> str:
        return self.email


class Organisation(models.Model):
    COUNTRIES = [("AU", "Australia"), ("GB", "United Kingdom")]
    SECTORS = [
        ("legal", "Legal"),
        ("accounting", "Accounting"),
        ("conveyancing", "Conveyancing"),
        ("real_estate", "Real estate"),
        ("dealer", "Precious stones and metals dealer"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    slug = models.SlugField(max_length=80, unique=True)
    country = models.CharField(max_length=2, choices=COUNTRIES, default="AU")
    abn = models.CharField(max_length=20, blank=True, default="")
    address = models.CharField(max_length=300, blank=True, default="")
    sector = models.CharField(max_length=20, choices=SECTORS, default="legal")
    settings = models.JSONField(default=dict, blank=True)  # OrgSettings overrides; defaults in accounts.services
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class Membership(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(Organisation, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=32)
    joined_at = models.DateTimeField(auto_now_add=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["org", "user"], name="uniq_membership_org_user")]
        ordering = ["joined_at"]

    def __str__(self) -> str:
        return f"{self.user_id} in {self.org_id} as {self.role}"


class Invitation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(Organisation, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField()
    role = models.CharField(max_length=32)
    token_hash = models.CharField(max_length=64, unique=True)  # HMAC-SHA256 of the token; the token is shown once
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    invited_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["org", "email"])]

    def __str__(self) -> str:
        return f"Invitation {self.id} ({self.role})"


class TrainingRecord(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(Organisation, on_delete=models.CASCADE, related_name="training_records")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="training_records")
    course = models.CharField(max_length=200)
    completed_on = models.DateField()
    due_on = models.DateField()
    evidence_note = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["due_on"]

    def __str__(self) -> str:
        return f"{self.course} ({self.user_id})"


class LoginFailure(models.Model):
    """Failed sign-ins per email (5 in 15 minutes locks that email for 15 minutes)."""

    id = models.BigAutoField(primary_key=True)
    email = models.CharField(max_length=254, db_index=True)
    ip = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    def __str__(self) -> str:
        return f"Failed sign-in {self.id}"
