"""Labelled synthetic client outcomes for the risk challenger (ADR 0004).

Each synthetic client carries the same feature ids the live system computes (risk.features.ML_FEATURES), an
onboarding month (for a time-ordered split) and protected attributes used ONLY for the fairness check
(nationality group, age band). The outcome is "the relationship later needed enhanced action": a suspicious
matter report, an exit for financial-crime reasons, or a confirmed adverse finding within 24 months.

Outcomes are drawn from a latent log-odds that deliberately contains structure the points-based rules cannot
express (interactions such as offshore layers combined with nominees, officer-hub networks with dormant
companies, ownership changes through offshore entities with untraced owners, and cycles that are fully
explained by a known owner being lower risk than the rules assume). Noise is added, so the labels are
imperfect, as real outcomes are. Synthetic labels limit what the challenger proves; the model card says so.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from ..features import ML_FEATURES

SETTINGS = Path(__file__).resolve().parents[1] / "data" / "generator.json"


def _cfg() -> dict:
    return json.loads(SETTINGS.read_text())


def latent_logit(
    df: pd.DataFrame, rng: np.random.Generator, intercept: float, *, signal: float = 1.0, noise: float = 0.6
) -> np.ndarray:
    """Outcome log-odds. Several factors the rules score unconditionally only matter in combination here
    (remote channel, formation services, client money, trusts, recent changes, cycles, PEPs in a structure),
    and officer networks and untraced ownership act non-linearly."""
    off = (df.n_offshore_entities > 0).astype(float)
    nominee = (df.nominee_indicators > 0).astype(float)
    hrj = (df.n_high_risk_jurisdictions >= 1).astype(float)
    recent = (df.recent_ownership_changes_12m >= 1).astype(float)
    entity = 1.0 - df.kind_individual
    explained_cycle = ((df.has_cycle == 1) & (df.unexplained_pct <= 55) & (df.n_ubos >= 1)).astype(float)
    risk = (
        2.0 * df.pep_client
        + 1.6 * df.pep_in_structure * np.maximum(off, hrj)
        + 3.5 * df.sanctions_confirmed
        + 1.4 * df.sanctions_possible
        + 1.1 * hrj
        + 0.25 * off
        + 1.6 * off * nominee
        + 1.2 * np.tanh(df.max_officer_appointments / 15.0) * np.tanh(df.dormant_linked_companies / 8.0) * 2
        + 0.6 * np.log1p(df.shared_officer_cluster_size)
        + 1.8 * (df.unexplained_pct >= 40)
        + 0.4 * (df.unexplained_pct >= 15)
        + 1.2 * df.has_cycle * (1 - explained_cycle)
        - 0.3 * explained_cycle
        + 1.5 * recent * off * (df.unexplained_pct >= 20)
        + 0.9 * df.service_formation * off
        + 0.8 * df.service_client_funds * nominee
        + 1.2 * df.service_property * df.foreign_client * df.channel_remote
        + 0.7 * df.trust_in_chain * off
        + 0.12 * (df.n_layers_to_ubo - 3).clip(lower=0)
        + 0.2 * df.channel_intermediary * entity
    )
    z = intercept + signal * risk
    return z.to_numpy(float) + rng.normal(0.0, noise, len(df))


def generate(n: int | None = None, seed: int | None = None) -> pd.DataFrame:
    cfg = _cfg()
    n = int(n or cfg["clients"])
    rng = np.random.default_rng(int(seed if seed is not None else cfg["seed"]))
    kind = rng.choice(["individual", "company", "trust", "partnership"], size=n, p=[0.45, 0.35, 0.12, 0.08])
    df = pd.DataFrame({"kind": kind})
    for k in ("individual", "company", "trust", "partnership"):
        df[f"kind_{k}"] = (df.kind == k).astype(int)
    entity = (df.kind != "individual").to_numpy()
    df["foreign_client"] = (rng.random(n) < np.where(entity, 0.08, 0.14)).astype(int)
    df["service_formation"] = (rng.random(n) < np.where(entity, 0.14, 0.02)).astype(int)
    df["service_client_funds"] = (rng.random(n) < 0.3).astype(int)
    df["service_property"] = (rng.random(n) < np.where(entity, 0.3, 0.6)).astype(int)
    df["n_services"] = 1 + df.service_formation + df.service_client_funds + (rng.random(n) < 0.3).astype(int)
    ch = rng.choice(["face_to_face", "remote", "intermediary"], size=n, p=[0.7, 0.2, 0.1])
    df["channel_remote"] = (ch == "remote").astype(int)
    df["channel_intermediary"] = (ch == "intermediary").astype(int)
    layers = np.where(entity, 1 + rng.geometric(0.55, n) - 1, 0).clip(0, 7)
    df["n_layers_to_ubo"] = layers
    df["trust_in_chain"] = np.where(df.kind == "trust", 1, (entity & (rng.random(n) < 0.22)).astype(int))
    off = np.where(entity, rng.poisson(0.12 * np.maximum(layers, 1)), 0)
    df["n_offshore_entities"] = off.clip(0, 5)
    df["n_high_risk_jurisdictions"] = (rng.random(n) < np.where(off > 0, 0.3, 0.03)).astype(int)
    df["has_cycle"] = (entity & (rng.random(n) < 0.035)).astype(int)
    nominee = entity & (rng.random(n) < np.where(off > 0, 0.35, 0.05))
    df["nominee_indicators"] = np.where(nominee, 1 + rng.poisson(0.6, n), 0)
    hub = entity & (rng.random(n) < np.where(nominee, 0.35, 0.03))
    df["max_officer_appointments"] = np.where(
        hub, rng.integers(10, 60, n), np.where(entity, 1 + rng.poisson(1.2, n), 0)
    )
    df["dormant_linked_companies"] = np.where(hub, rng.integers(3, 45, n), rng.poisson(0.2, n) * entity)
    df["shared_officer_cluster_size"] = np.where(hub, rng.poisson(2.5, n), rng.poisson(0.15, n) * entity)
    df["shared_address_cluster_size"] = np.where(
        hub, rng.integers(4, 45, n), np.where(rng.random(n) < 0.05, rng.integers(2, 6, n), 0)
    )
    unexpl = np.where(entity & (rng.random(n) < 0.12), rng.uniform(5, 60, n).round(1), 0.0)
    df["unexplained_pct"] = np.where(df.has_cycle == 1, np.maximum(unexpl, rng.uniform(20, 70, n).round(1)), unexpl)
    df["n_ubos"] = np.where(entity, np.clip(rng.poisson(1.6, n) + (df.unexplained_pct < 75), 0, 5), 0)
    df["pep_client"] = ((~entity) & (rng.random(n) < 0.02)).astype(int)
    df["pep_in_structure"] = np.where(df.pep_client == 1, 1, (entity & (rng.random(n) < 0.03)).astype(int))
    df["sanctions_possible"] = (rng.random(n) < np.where(off > 0, 0.04, 0.008)).astype(int)
    df["sanctions_confirmed"] = (rng.random(n) < 0.002).astype(int)
    df["recent_ownership_changes_12m"] = np.where(entity & (rng.random(n) < 0.09), 1 + rng.poisson(0.3, n), 0)
    # fairness-only attributes (never features)
    df["nationality_group"] = np.where(
        rng.random(n) < np.where(df.foreign_client == 1, 0.8, 0.25), "born_overseas", "born_in_country"
    )
    age = rng.choice(["18-34", "35-54", "55+"], size=n, p=[0.3, 0.42, 0.28])
    df["age_band"] = np.where(entity, "entity", age)
    df["month"] = rng.integers(0, 36, n)
    z = latent_logit(df, rng, float(cfg["intercept"]), signal=float(cfg["signal"]), noise=float(cfg["noise"]))
    df["label"] = (rng.random(n) < 1 / (1 + np.exp(-z))).astype(int)
    for c in ML_FEATURES:
        df[c] = df[c].astype(float)
    return df


def split(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Time-ordered: train on earlier onboarding cohorts, test on the latest (no look-ahead)."""
    cuts = _cfg()["month_cuts"]
    return {
        "train": df[df.month < cuts["calib"]].reset_index(drop=True),
        "calib": df[(df.month >= cuts["calib"]) & (df.month < cuts["valid"])].reset_index(drop=True),
        "valid": df[(df.month >= cuts["valid"]) & (df.month < cuts["test"])].reset_index(drop=True),
        "test": df[df.month >= cuts["test"]].reset_index(drop=True),
    }
