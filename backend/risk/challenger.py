"""Runtime risk challenger: loads backend/artifacts/models/risk/ and scores one client offline.

Returns a calibrated probability, the challenger's rating, plain-language TreeSHAP reasons and whether it
disagrees with the rules rating (policy in policy.json).
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from graph.common import kinroot_setting
from kinroot.contracts import MatchReason
from resolution.ml.common import Isotonic

from .features import FEATURE_LABELS, ML_FEATURES, vector
from .ml.train import RATING, challenger_rating, disagrees

log = logging.getLogger(__name__)
_lock = threading.Lock()
_cache: dict[tuple[str, str], Any] = {}
RATING_NAMES = {v: k for k, v in RATING.items()}


def model_dir() -> Path:
    return Path(kinroot_setting("MODEL_DIR")) / "risk"


def manifest() -> dict[str, Any]:
    path = model_dir() / "manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"risk challenger artifacts missing at {path}; run `make train`")
    return json.loads(path.read_text())


@dataclass
class Challenger:
    version: str
    kind: str
    calibrator: Isotonic
    policy: dict[str, Any]
    booster: Any = None
    logreg: dict[str, Any] | None = None

    def probability(self, x: np.ndarray) -> float:
        if self.kind == "lightgbm":
            raw = self.booster.predict(x.reshape(1, -1))
        else:
            assert self.logreg is not None
            z = ((x - np.array(self.logreg["mean"])) / np.array(self.logreg["scale"])) @ np.array(
                self.logreg["coef"]
            ) + self.logreg["intercept"]
            raw = np.array([1.0 / (1.0 + np.exp(-z))])
        return float(self.calibrator(raw)[0])

    def contributions(self, x: np.ndarray) -> dict[str, float]:
        if self.kind == "lightgbm":
            c = self.booster.predict(x.reshape(1, -1), pred_contrib=True)[0][:-1]
        else:
            assert self.logreg is not None
            c = ((x - np.array(self.logreg["mean"])) / np.array(self.logreg["scale"])) * np.array(self.logreg["coef"])
        return {f: float(v) for f, v in zip(ML_FEATURES, c, strict=True)}


def _active_version(man: dict[str, Any], org_id: Any = None) -> str:
    try:
        from .models import ModelPromotion

        # each firm signs off its own champion; promotions are never shared between firms
        promo = (
            ModelPromotion.objects.filter(model_name="risk-challenger", stage="champion", org_id=org_id)
            .order_by("-id")
            .first()
        )
        if promo and promo.version in man["versions"]:
            return promo.version
    except Exception:
        log.debug("promotion lookup unavailable", exc_info=True)
    return man["champion"]


def load(version: str | None = None, *, org_id: Any = None) -> Challenger:
    """The firm's champion (its latest promotion, else the trained default) unless `version` is given."""
    man = manifest()
    version = version or _active_version(man, org_id)
    key = (str(model_dir()), version)
    with _lock:
        if key in _cache:
            return _cache[key]
        d = model_dir()
        spec = man["versions"][version]
        policy = json.loads((d / "policy.json").read_text())
        cal = Isotonic.from_dict(json.loads((d / spec["calibrator"]).read_text()))
        if spec["kind"] == "lightgbm":
            import lightgbm as lgb

            ch = Challenger(
                version, "lightgbm", cal, policy, booster=lgb.Booster(model_str=(d / spec["model"]).read_text())
            )
        else:
            ch = Challenger(version, "logreg", cal, policy, logreg=json.loads((d / spec["model"]).read_text()))
        _cache[key] = ch
        return ch


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _reason_label(feature: str, value: float, contribution: float) -> str:
    base = FEATURE_LABELS.get(feature, feature.replace("_", " "))
    binary = feature.startswith(("kind_", "service_", "channel_", "pep_", "sanctions_")) or feature in (
        "foreign_client",
        "has_cycle",
        "trust_in_chain",
    )
    if binary:
        return base if value >= 1 else f"No {base[0].lower()}{base[1:]}"
    shown = f"{value:g}" + ("%" if feature == "unexplained_pct" else "")
    return f"{base}: {shown}"


def score(
    features: dict[str, Any], rules_rating: str, challenger: Challenger | None = None, *, org_id: Any = None
) -> dict[str, Any]:
    ch = challenger or load(org_id=org_id)
    x = np.array(vector(features), float)
    p = ch.probability(x)
    thr = ch.policy["rating_thresholds"]
    rating = RATING_NAMES[int(challenger_rating(p, thr))]
    contrib = ch.contributions(x)
    ranked = sorted(((f, c) for f, c in contrib.items() if abs(c) > 1e-6), key=lambda fc: (-abs(fc[1]), fc[0]))[:5]
    reasons = [
        MatchReason(
            feature=f,
            label=_reason_label(f, float(features.get(f, 0) or 0), c),
            direction="for" if c > 0 else "against",
            contribution=round(float(c), 4),
            value=f"{float(features.get(f, 0) or 0):g}",
        )
        for f, c in ranked
    ]
    disagree = disagrees(RATING[rules_rating], p, thr, float(ch.policy["disagreement_margin"]))
    return {
        "model_version": ch.version,
        "probability_high": round(p, 4),
        "rating": rating,
        "agreement": "disagree" if disagree else "agree",
        "reasons": reasons,
    }
