"""`manage.py reset_demo --yes`: drop local data (SQLite database, graph files, uploads) before re-seeding.

`make reset` runs this, then `migrate` and `seed_demo`. On Postgres it flushes every table instead.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import connection


class Command(BaseCommand):
    help = "Delete local Kinroot data (database, graph, uploads). Requires --yes."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--yes", action="store_true", help="Confirm that local data should be deleted.")

    def handle(self, *args: Any, **opts: Any) -> None:
        if not opts["yes"]:
            raise CommandError("This deletes all local data. Re-run with --yes to confirm.")
        if getattr(settings, "IS_PROD", False):
            raise CommandError("Refusing to reset a production environment.")
        db = settings.DATABASES["default"]
        if db["ENGINE"].endswith("sqlite3") and db["NAME"] != ":memory:":
            connection.close()
            path = Path(db["NAME"])
            for suffix in ("", "-wal", "-shm"):
                target = path.with_name(path.name + suffix)
                if target.exists():
                    target.unlink()
            self.stdout.write(f"Removed {path.name}")
        else:
            call_command("flush", "--noinput")
            self.stdout.write("Flushed the database")
        graph_path = Path(settings.KINROOT["GRAPH_PATH"])
        for target in (graph_path, graph_path.with_name(graph_path.name + ".wal"), Path(settings.MEDIA_ROOT)):
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
        self.stdout.write(
            self.style.SUCCESS("Local data removed. Run migrate and seed_demo next (make reset does both).")
        )
