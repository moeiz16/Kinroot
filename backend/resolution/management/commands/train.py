"""`python manage.py train er|risk|all`: retrain the committed models from fixed seeds (CPU, minutes).

Run under the heavy lock (one training job at a time). Writes backend/artifacts/models/<er|risk>/ and the
held-out eval fixtures under eval/fixtures/, and tracks the run in MLflow (local SQLite + mlruns/).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand

from graph.common import kinroot_setting

EVAL_FIXTURES = Path(settings.REPO_DIR) / "eval" / "fixtures"


class Command(BaseCommand):
    help = "Train the entity-resolution matcher and/or the risk challenger."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("target", choices=["er", "risk", "all"])
        parser.add_argument("--trials", type=int, default=40, help="Optuna trials")
        parser.add_argument("--scale", type=float, default=1.0, help="data scale (1.0 = full)")
        parser.add_argument("--no-track", action="store_true", help="skip MLflow tracking")
        parser.add_argument("--out", default=None, help="artifact directory (default MODEL_DIR)")

    def handle(self, *args: Any, **opts: Any) -> None:
        base = Path(opts["out"] or kinroot_setting("MODEL_DIR"))
        track = not opts["no_track"]
        if opts["target"] in ("er", "all"):
            from resolution.ml.train import train as train_er

            r = train_er(base / "er", trials=opts["trials"], scale=opts["scale"], eval_dir=EVAL_FIXTURES, track=track)
            m = r["metrics_test"]["lightgbm"]
            self.stdout.write(
                f"er-matcher {r['version']}: F1 {m['f1']} AP {m.get('average_precision')} auto-merge precision "
                f"{m['auto_merge_precision']} review rate {m['review_rate']}"
            )
        if opts["target"] in ("risk", "all"):
            from risk.ml.train import train as train_risk

            r = train_risk(base / "risk", trials=opts["trials"], eval_dir=EVAL_FIXTURES, track=track)
            m = r["metrics_test"]["lightgbm"]
            self.stdout.write(
                f"risk-challenger {r['version']}: AUC {m.get('roc_auc')} Brier {m['brier']} ECE {m['ece']}"
            )
