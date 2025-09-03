"""Accounts: users, organisations (firms), memberships and invitations. Owner: builder A.

Only the custom user model is defined so far (AUTH_USER_MODEL must exist before the first migration).
Organisation, Membership and Invitation follow docs/API_CONTRACT.md Part 2.
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
