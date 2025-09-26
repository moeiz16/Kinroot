"""Fellegi-Sunter probabilistic record linkage, the transparent baseline (ADR 0003 step 4).

Each comparison field is discretised into agreement levels; m(level) = P(level | match) and u(level) =
P(level | non-match) are estimated by expectation-maximisation on *unlabelled* blocked pairs under the usual
conditional-independence assumption. A pair's weight is the sum of log2(m/u) over its non-missing fields; the
posterior match probability uses the EM-estimated prior. Missing fields contribute nothing.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# field -> function(features) -> level index or None (missing)
FIELDS: dict[str, list[str]] = {
    "name": ["disagree", "similar", "agree"],
    "given": ["disagree", "initial", "agree"],
    "surname": ["disagree", "similar", "agree"],
    "dob": ["disagree", "same_year", "partial", "transposed", "exact"],
    "identifier": ["disagree", "agree"],
    "address": ["disagree", "partial", "agree"],
    "postcode": ["disagree", "agree"],
    "nationality": ["disagree", "agree"],
    "jurisdiction": ["disagree", "agree"],
}


def levels(f: dict[str, float]) -> dict[str, int | None]:
    def three(v: float, hi: float, lo: float) -> int | None:
        if v < 0:
            return None
        return 2 if v >= hi else (1 if v >= lo else 0)

    def flag(v: float) -> int | None:
        return None if v < 0 else int(v >= 1)

    if f["dob_year_diff"] < 0:
        dob: int | None = None
    elif f["dob_exact"] == 1:
        dob = 4
    elif f["dob_transposed"] == 1:
        dob = 3
    elif f["dob_partial"] == 1:
        dob = 2  # same month and year (or same year when months are unknown)
    elif f["dob_year_diff"] == 0:
        dob = 1
    else:
        dob = 0
    g = f["given_name_agree"]
    given = None if g < 0 else (2 if g >= 1 else (1 if g >= 0.5 else 0))
    return {
        "name": three(f["name_jaro_winkler"], 0.95, 0.85),
        "given": given,
        "surname": three(f["surname_jaro_winkler"], 0.97, 0.88),
        "dob": dob,
        "identifier": flag(f["id_agree"]),
        "address": three(f["address_token_overlap"], 0.6, 0.3),
        "postcode": flag(f["postcode_agree"]),
        "nationality": flag(f["nationality_agree"]),
        "jurisdiction": flag(f["jurisdiction_agree"]),
    }


@dataclass
class FellegiSunter:
    m: dict[str, list[float]] = field(default_factory=dict)
    u: dict[str, list[float]] = field(default_factory=dict)
    prior: float = 0.1
    iterations: int = 0

    # ── estimation ──
    def fit(
        self, rows: Sequence[dict[str, float]], *, max_iter: int = 200, tol: float = 1e-7, prior: float = 0.1
    ) -> FellegiSunter:
        obs = [levels(r) for r in rows]
        n = len(obs)
        if n == 0:
            raise ValueError("no pairs to fit")
        self.prior = prior
        # initialisation: matches mostly agree, non-matches follow the overall level frequencies
        for name, lv in FIELDS.items():
            k = len(lv)
            m = np.linspace(0.05, 1.0, k) ** 3
            self.m[name] = list(m / m.sum())
            counts = np.ones(k)
            for o in obs:
                if o[name] is not None:
                    counts[o[name]] += 1
            self.u[name] = list(counts / counts.sum())
        prev = -math.inf
        for it in range(max_iter):
            post = self.posterior_levels(obs)
            # M-step
            self.prior = float(min(0.99, max(1e-4, post.mean())))
            for name, lv in FIELDS.items():
                k = len(lv)
                mm, uu = np.full(k, 1e-3), np.full(k, 1e-3)
                for o, g in zip(obs, post, strict=True):
                    level = o[name]
                    if level is None:
                        continue
                    mm[level] += g
                    uu[level] += 1 - g
                self.m[name] = list(mm / mm.sum())
                self.u[name] = list(uu / uu.sum())
            ll = float(np.sum(np.log(np.maximum(1e-300, self._joint(obs)))))
            self.iterations = it + 1
            if abs(ll - prev) < tol * max(1.0, abs(ll)):
                break
            prev = ll
        # identify the "match" class: the component whose identifier/dob agreement is higher
        if self.m["name"][-1] < self.u["name"][-1]:
            self.m, self.u = self.u, self.m
            self.prior = 1 - self.prior
        return self

    def _joint(self, obs: list[dict[str, int | None]]) -> np.ndarray:
        out = np.empty(len(obs))
        for i, o in enumerate(obs):
            pm, pu = self.prior, 1 - self.prior
            for name, level in o.items():
                if level is not None:
                    pm *= self.m[name][level]
                    pu *= self.u[name][level]
            out[i] = pm + pu
        return out

    def posterior_levels(self, obs: list[dict[str, int | None]]) -> np.ndarray:
        out = np.empty(len(obs))
        lp, lq = math.log(self.prior), math.log(1 - self.prior)
        for i, o in enumerate(obs):
            a, b = lp, lq
            for name, level in o.items():
                if level is not None:
                    a += math.log(self.m[name][level])
                    b += math.log(self.u[name][level])
            out[i] = 1.0 / (1.0 + math.exp(min(700.0, b - a)))
        return out

    # ── scoring ──
    def weights(self, f: dict[str, float]) -> dict[str, float]:
        out = {}
        for name, level in levels(f).items():
            if level is not None:
                out[name] = math.log2(self.m[name][level] / self.u[name][level])
        return out

    def weight(self, f: dict[str, float]) -> float:
        return round(sum(self.weights(f).values()), 4)

    def probability(self, f: dict[str, float]) -> float:
        w = self.weight(f) + math.log2(self.prior / (1 - self.prior))
        return round(1.0 / (1.0 + 2.0 ** (-w)), 6)

    def probabilities(self, rows: Sequence[dict[str, float]]) -> np.ndarray:
        return np.array([self.probability(r) for r in rows])

    # ── persistence ──
    def to_dict(self) -> dict:
        return {"m": self.m, "u": self.u, "prior": self.prior, "iterations": self.iterations, "levels": FIELDS}

    @classmethod
    def from_dict(cls, d: dict) -> FellegiSunter:
        return cls(m=d["m"], u=d["u"], prior=d["prior"], iterations=d.get("iterations", 0))

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(self.to_dict(), indent=1, sort_keys=True))

    @classmethod
    def load(cls, path: Path) -> FellegiSunter:
        return cls.from_dict(json.loads(path.read_text()))
