"""`manage.py seed_demo`: the sample firms Harbourline Legal (Sydney) and Northgate Accountants (London).

Idempotent: firms that already exist are left alone (`make reset` drops everything and seeds again).
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand

from clients.seed import Seeder


class Command(BaseCommand):
    help = "Seed the demo firms with sample (fictional) clients, structures and decisions."

    def handle(self, *args: Any, **opts: Any) -> None:
        result = Seeder(out=self.stdout.write).run()
        if result["harbourline"] or result["northgate"]:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Seeded in {result['seconds']}s. Sign in as daniel@harbourline.example "
                    "with the demo password from the README."
                )
            )
        else:
            self.stdout.write("Nothing to do: both sample firms already exist.")
