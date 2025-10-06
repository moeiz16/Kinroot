"""Runtime matcher: loads the committed artifacts (backend/artifacts/models/er/) and scores pairs offline.

The champion version is the one named in the artifact manifest unless a compliance officer promoted another
(risk.ModelPromotion). LightGBM's built-in TreeSHAP (`pred_contrib=True`) gives exact per-feature
contributions without loading the shap package at request time.
"""

from __future__ import annotations

import json
import logging
import math
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from graph.common import kinroot_setting

from .features import FEATURES, vector
from .fellegi_sunter import FellegiSunter
from .ml.common import Isotonic

log = logging.getLogger(__name__)
_lock = threading.Lock()
_cache: dict[tuple[str, str], Any] = {}


def model_dir() -> Path:
    return Path(kinroot_setting("MODEL_DIR")) / "er"


def manifest() -> dict[str, Any]:
    path = model_dir() / "manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"entity-resolution artifacts missing at {path}; run `make train`")
    return json.loads(path.read_text())


def logreg_design(rows: np.ndarray) -> np.ndarray:
    """Logistic baseline design: raw features plus a missing indicator per feature (-1 = missing)."""
    rows = np.asarray(rows, float)
    missing = (rows < 0).astype(float)
    clean = np.where(rows < 0, 0.0, rows)
    return np.hstack([clean, missing])


@dataclass
class Matcher:
    version: str
    kind: str  # lightgbm | logreg
    thresholds: dict[str, Any]
    fs: FellegiSunter
    booster: Any = None
    calibrator: Isotonic | None = None
    logreg: dict[str, Any] | None = None

    def raw(self, x: np.ndarray) -> np.ndarray:
        if self.kind == "lightgbm":
            return np.asarray(self.booster.predict(x), float)
        assert self.logreg is not None
        design = (logreg_design(x) - np.array(self.logreg["mean"])) / np.array(self.logreg["scale"])
        z = design @ np.array(self.logreg["coef"]) + self.logreg["intercept"]
        return 1.0 / (1.0 + np.exp(-z))

    def probability(self, x: np.ndarray) -> np.ndarray:
        raw = self.raw(x)
        return self.calibrator(raw) if self.calibrator is not None else raw

    def contributions(self, x: np.ndarray) -> dict[str, float]:
        if self.kind == "lightgbm":
            contrib = self.booster.predict(x.reshape(1, -1), pred_contrib=True)[0]
            return {f: float(c) for f, c in zip(FEATURES, contrib[:-1], strict=True)}
        assert self.logreg is not None
        design = (logreg_design(x.reshape(1, -1)) - np.array(self.logreg["mean"])) / np.array(self.logreg["scale"])
        coef = np.array(self.logreg["coef"])
        n = len(FEATURES)
        parts = design[0] * coef
        return {f: float(parts[i] + parts[i + n]) for i, f in enumerate(FEATURES)}

    def band(self, p: float, feats: dict[str, float] | None = None) -> str:
        if p >= self.thresholds["auto_merge"]:
            return "review" if feats is not None and conflicting_evidence(feats) else "auto_merge"
        return "review" if p >= self.thresholds["review"] else "reject"


def conflicting_evidence(f: dict[str, float]) -> bool:
    """Merge policy on top of the probability: a pair with any hard conflict is never merged without a human.
    Conflicts: different full dates of birth (not a day-month swap), different registration numbers, or
    clearly different addresses and postcodes."""
    dob_conflict = f.get("dob_exact") == 0 and f.get("dob_transposed") != 1
    id_conflict = f.get("id_agree") == 0
    address_conflict = 0 <= f.get("address_token_overlap", -1) < 0.3 and f.get("postcode_agree") == 0
    return bool(dob_conflict or id_conflict or address_conflict)


def _active_version(man: dict[str, Any], org_id: Any = None) -> str:
    try:
        from risk.models import ModelPromotion

        # each firm signs off its own champion; promotions are never shared between firms
        promo = (
            ModelPromotion.objects.filter(model_name="er-matcher", stage="champion", org_id=org_id)
            .order_by("-id")
            .first()
        )
        if promo and promo.version in man["versions"]:
            return promo.version
    except Exception:  # tables not migrated yet (e.g. during the first migrate)
        log.debug("promotion lookup unavailable", exc_info=True)
    return man["champion"]


def load(version: str | None = None, *, org_id: Any = None) -> Matcher:
    """The firm's champion (its latest promotion, else the trained default) unless `version` is given."""
    man = manifest()
    version = version or _active_version(man, org_id)
    key = (str(model_dir()), version)
    with _lock:
        if key in _cache:
            return _cache[key]
        spec = man["versions"][version]
        d = model_dir()
        fs = FellegiSunter.load(d / man["fellegi_sunter"])
        thresholds = json.loads((d / spec["thresholds"]).read_text())
        if spec["kind"] == "lightgbm":
            import lightgbm as lgb

            booster = lgb.Booster(model_str=(d / spec["model"]).read_text())
            calibrator = Isotonic.from_dict(json.loads((d / spec["calibrator"]).read_text()))
            m = Matcher(version, "lightgbm", thresholds, fs, booster=booster, calibrator=calibrator)
        else:
            lr = json.loads((d / spec["model"]).read_text())
            cal = (
                Isotonic.from_dict(json.loads((d / spec["calibrator"]).read_text())) if spec.get("calibrator") else None
            )
            m = Matcher(version, "logreg", thresholds, fs, logreg=lr, calibrator=cal)
        _cache[key] = m
        return m


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def score_features(feats: dict[str, float], matcher: Matcher | None = None) -> dict[str, Any]:
    m = matcher or load()
    x = np.array(vector(feats), float)
    p = float(m.probability(x.reshape(1, -1))[0])
    fs_w = m.fs.weight(feats)
    fs_p = m.fs.probability(feats)
    return {
        "probability": round(p, 4),
        "band": m.band(p, feats),
        "fs_weight": round(fs_w, 3),
        "fs_probability": round(fs_p if math.isfinite(fs_p) else 0.0, 4),
        "contributions": m.contributions(x),
        "model_version": m.version,
    }
