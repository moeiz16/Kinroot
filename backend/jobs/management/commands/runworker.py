"""`manage.py runworker`: the job worker and single graph writer (ADR 0002)."""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand

from jobs import worker


class Command(BaseCommand):
    help = "Run the background job worker (claims jobs, drains the graph outbox, schedules daily monitoring)."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--once", action="store_true", help="Run one pass and exit.")
        parser.add_argument("--poll", type=float, default=None, help="Seconds between polls when idle.")

    def handle(self, *args: Any, **opts: Any) -> None:
        try:
            worker.loop(once=opts["once"], poll=opts["poll"])
        except KeyboardInterrupt:
            self.stdout.write("worker stopped")
