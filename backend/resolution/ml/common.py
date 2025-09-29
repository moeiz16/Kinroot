"""Shared ML utilities for the entity-resolution matcher and the risk challenger.

Everything that ends up in committed artifacts is deterministic (sorted keys, rounded floats, gzip mtime 0) so
`make train` reproduces the same files from the same seeds. MLflow (local SQLite + mlruns/) keeps the run
history, which is git-ignored.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import logging
import os
from collections.abc import Iterable
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)

log = logging.getLogger(__name__)


def r4(x: float) -> float:
    return float(round(float(x), 4))


def ece(y: np.ndarray, p: np.ndarray, bins: int = 10) -> float:
    """Expected calibration error with equal-width bins."""
    y, p = np.asarray(y, float), np.asarray(p, float)
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    total = 0.0
    for b in range(bins):
        mask = idx == b
        if mask.any():
            total += mask.mean() * abs(y[mask].mean() - p[mask].mean())
    return float(total)


def binary_metrics(y: np.ndarray, p: np.ndarray, threshold: float = 0.5) -> dict[str, float]:
    yhat = (p >= threshold).astype(int)
    out = {
        "precision": r4(precision_score(y, yhat, zero_division=0)),
        "recall": r4(recall_score(y, yhat, zero_division=0)),
        "f1": r4(f1_score(y, yhat, zero_division=0)),
        "threshold": r4(threshold),
        "brier": r4(brier_score_loss(y, np.clip(p, 0, 1))),
        "ece": r4(ece(y, p)),
    }
    if len(set(np.asarray(y).tolist())) > 1:
        out["average_precision"] = r4(average_precision_score(y, p))
        out["roc_auc"] = r4(roc_auc_score(y, p))
    return out


def best_f1_threshold(y: np.ndarray, p: np.ndarray) -> float:
    best_t, best_f = 0.5, -1.0
    for t in np.unique(np.round(p, 4)):
        f = f1_score(y, (p >= t).astype(int), zero_division=0)
        if f > best_f + 1e-12:
            best_t, best_f = float(t), f
    return best_t


def precision_threshold(y: np.ndarray, p: np.ndarray, target: float) -> float:
    """Smallest threshold whose predicted-positive set has precision >= target (and at least 20 positives)."""
    order = np.argsort(-p)
    ys, ps = np.asarray(y)[order], np.asarray(p)[order]
    tp = np.cumsum(ys)
    n = np.arange(1, len(ys) + 1)
    prec = tp / n
    best = 1.0
    for i in range(len(ps)):
        if i + 1 < len(ps) and ps[i + 1] == ps[i]:
            continue  # evaluate at the end of a tie block
        if prec[i] >= target and tp[i] >= 20:
            best = float(ps[i])
    return best


def recall_threshold(y: np.ndarray, p: np.ndarray, target: float) -> float:
    """Largest threshold that still captures >= target of the positives."""
    pos = np.sort(np.asarray(p)[np.asarray(y) == 1])[::-1]
    if len(pos) == 0:
        return 0.5
    k = int(np.ceil(target * len(pos))) - 1
    return float(pos[min(max(k, 0), len(pos) - 1)])


class Isotonic:
    """Isotonic calibration stored as plain breakpoints (JSON), applied with linear interpolation."""

    def __init__(self, x: list[float] | None = None, y: list[float] | None = None) -> None:
        self.x = x or [0.0, 1.0]
        self.y = y or [0.0, 1.0]

    def fit(self, raw: np.ndarray, labels: np.ndarray) -> Isotonic:
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        iso.fit(raw, labels)
        self.x = [r4(v) for v in iso.X_thresholds_]
        self.y = [r4(v) for v in iso.y_thresholds_]
        return self

    def __call__(self, raw: np.ndarray | float) -> np.ndarray:
        return np.interp(np.asarray(raw, float), self.x, self.y)

    def to_dict(self) -> dict[str, list[float]]:
        return {"x": self.x, "y": self.y}

    @classmethod
    def from_dict(cls, d: dict[str, list[float]]) -> Isotonic:
        return cls(d["x"], d["y"])


def psi(expected: Iterable[float], actual: Iterable[float], edges: list[float]) -> float:
    """Population stability index between a reference sample and a current one over fixed bin edges."""
    e = np.histogram(np.asarray(list(expected), float), bins=edges)[0].astype(float)
    a = np.histogram(np.asarray(list(actual), float), bins=edges)[0].astype(float)
    e = np.clip(e / max(e.sum(), 1.0), 1e-4, None)
    a = np.clip(a / max(a.sum(), 1.0), 1e-4, None)
    return float(np.sum((a - e) * np.log(a / e)))


def psi_status(value: float) -> str:
    return "stable" if value < 0.1 else ("watch" if value < 0.25 else "drift")


def quantile_edges(values: np.ndarray, bins: int = 10) -> list[float]:
    qs = np.unique(np.quantile(np.asarray(values, float), np.linspace(0, 1, bins + 1)))
    if len(qs) < 3:
        lo, hi = float(np.min(values)), float(np.max(values))
        qs = np.array([lo - 1e-9, (lo + hi) / 2, hi + 1e-9])
    qs[0], qs[-1] = -1e9, 1e9
    return [r4(v) if abs(v) < 1e8 else float(v) for v in qs]


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, sort_keys=True, default=_jsonable) + "\n")


def _jsonable(v: Any) -> Any:
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.floating):
        return r4(float(v))
    if isinstance(v, np.ndarray):
        return v.tolist()
    raise TypeError(type(v))


def write_csv_gz(path: Path, frame: Any) -> None:
    """Deterministic gzip (mtime 0) so the same data gives the same bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    frame.to_csv(buf, index=False, float_format="%.4f", lineterminator="\n")
    with path.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as gz:
        gz.write(buf.getvalue().encode())


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def strip_lightgbm_dump(path: Path) -> None:
    """LightGBM appends the full parameter block (including absolute paths); keep the model deterministic."""
    text = path.read_text()
    cut = text.find("\nparameters:")
    if cut != -1:
        end = text.find("end of parameters", cut)
        if end != -1:
            text = text[:cut] + "\n" + text[end + len("end of parameters") :]
    path.write_text(text)


@contextmanager
def mlflow_run(experiment: str, run_name: str, *, tags: dict[str, str] | None = None):
    """A tracked MLflow run (local SQLite + mlruns/). Yields the mlflow module or None if MLflow is unavailable."""
    os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
    try:
        import mlflow

        from graph.common import kinroot_setting

        uri = str(kinroot_setting("MLFLOW_TRACKING_URI"))
        if uri.startswith("sqlite:///"):
            Path(uri.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
        mlflow.set_tracking_uri(uri)
        exp = mlflow.get_experiment_by_name(experiment)
        exp_id = (
            exp.experiment_id
            if exp
            else mlflow.create_experiment(
                experiment, artifact_location=str(Path(str(kinroot_setting("MLFLOW_ARTIFACT_ROOT"))) / experiment)
            )
        )
        with mlflow.start_run(experiment_id=exp_id, run_name=run_name, tags=tags or {}):
            yield mlflow
    except ImportError:  # pragma: no cover
        log.warning("MLflow not installed; run not tracked")
        yield None


def register_version(
    model_name: str, run_id: str, artifact_uri: str, version_label: str, alias: str = "champion"
) -> str | None:
    """Register the run's artifacts as a model version and point an alias (champion/challenger) at it."""
    try:
        from mlflow import MlflowClient

        client = MlflowClient()
        try:
            client.create_registered_model(model_name)
        except Exception:  # already registered
            log.debug("registered model exists", exc_info=True)
        mv = client.create_model_version(
            model_name, source=artifact_uri, run_id=run_id, tags={"kinroot_version": version_label}
        )
        client.set_registered_model_alias(model_name, alias, mv.version)
        return str(mv.version)
    except Exception:  # pragma: no cover - tracking is best effort
        log.warning("model registry update failed", exc_info=True)
        return None
