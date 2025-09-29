"""Labelled pair set for the entity-resolution matcher (ADR 0003 step 5).

Entities (the ground-truth clusters):
- UK register people: individual PSC records from the Companies House snapshot in data/ (real name, birth
  month/year, nationality and locality distributions). Absent in CI: the generator falls back to synthetic people.
- Synthetic AU people across several name origins (also used for the fairness breakdown).
- Synthetic AU companies (valid ACN check digits) and UK corporate PSC companies from the snapshot.
Each entity yields 1-3 records through controlled perturbations (typos, nicknames, initials, swapped order,
honorifics, transliteration, partial or transposed birth dates, moved addresses, reformatted identifiers, legal
form variants). Hard negatives are added on purpose: namesakes (same name, different person), relatives (same
surname and address), sibling companies (shared name stem, different number).

Pairs are produced by the production blocking function, so the label distribution and the review-queue rate
match what the live system sees; true matches lost by blocking are counted for blocking recall.
Split is by entity: every entity belongs to exactly one fold and only within-fold pairs are kept, so no
person or company appears on both sides of a train/test boundary.
"""

from __future__ import annotations

import json
import random
import string
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ..blocking import candidate_pairs
from ..features import FEATURES, compare, prepare
from ..normalize import ascii_fold

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
REPO_DIR = Path(__file__).resolve().parents[3]
CH_PEOPLE = REPO_DIR / "data" / "companies_house" / "psc_individuals.jsonl"
CH_STRUCTURES = REPO_DIR / "data" / "companies_house" / "psc_structures.jsonl"
SPLITS = ("train", "valid", "calib", "test")


@dataclass
class Entity:
    eid: str
    kind: str
    origin: str
    split: str
    attrs: dict[str, Any]
    records: list[dict[str, Any]] = field(default_factory=list)


def _weighted(rng: random.Random, weights: dict[str, float]) -> str:
    keys = list(weights)
    return rng.choices(keys, weights=[weights[k] for k in keys])[0]


def acn_with_check(rng: random.Random) -> str:
    digits = [rng.randint(0, 9) for _ in range(8)]
    total = sum(d * w for d, w in zip(digits, range(8, 0, -1), strict=True))
    return "".join(map(str, digits)) + str((10 - total % 10) % 10)


def abn_from_acn(acn: str) -> str:
    """An ABN whose last nine digits are the ACN, with valid ABN check digits."""
    weights = (10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19)
    for prefix in range(10, 100):
        digits = [int(c) for c in f"{prefix}{acn}"]
        digits[0] -= 1
        if sum(a * b for a, b in zip(digits, weights, strict=True)) % 89 == 0:
            return f"{prefix}{acn}"
    return f"51{acn}"


NATIONALITY_TEXT = {
    "British": "GB",
    "English": "GB",
    "Scottish": "GB",
    "Welsh": "GB",
    "Irish": "IE",
    "Indian": "IN",
    "Polish": "PL",
    "American": "US",
    "Australian": "AU",
}
COUNTRY_TEXT = {
    "England": "GB",
    "Scotland": "GB",
    "Wales": "GB",
    "Northern Ireland": "GB",
    "United Kingdom": "GB",
    "Ireland": "IE",
}


class PairGenerator:
    def __init__(self, seed: int | None = None, *, use_register: bool | None = None, scale: float = 1.0) -> None:
        self.cfg = json.loads((DATA_DIR / "generator.json").read_text())
        self.names = json.loads((DATA_DIR / "names.json").read_text())
        self.seed = int(seed if seed is not None else self.cfg["seed"])
        self.rng = random.Random(self.seed)  # noqa: S311 - reproducible synthetic data, not security
        self.use_register = CH_PEOPLE.exists() if use_register is None else use_register
        self.scale = scale
        self.entities: list[Entity] = []
        self.source_note = ""

    # ── entity pools ──────────────────────────────────────────────────────────────────────────────
    def _split(self) -> str:
        return _weighted(self.rng, self.cfg["splits"])

    def _au_address(self) -> dict[str, str]:
        n = self.names
        loc, state, pc = self.rng.choice(n["localities"])
        return {
            "line1": f"{self.rng.randint(1, 240)} {self.rng.choice(n['streets'])} {self.rng.choice(n['street_types'])}",
            "locality": loc,
            "state": state,
            "postcode": pc,
            "country": "AU",
        }

    def _birth(self, lo: int = 1940, hi: int = 2004) -> tuple[int, int, int]:
        return self.rng.randint(lo, hi), self.rng.randint(1, 12), self.rng.randint(1, 28)

    def _synthetic_person(self, origin: str | None = None) -> dict[str, Any]:
        origin = origin or _weighted(self.rng, self.names["origin_weights"])
        pool = self.names["origins"][origin]
        female = self.rng.random() < 0.5
        given = self.rng.choice(pool["given_f"] if female else pool["given_m"])
        middle = self.rng.choice(pool["given_f"] if female else pool["given_m"]) if self.rng.random() < 0.35 else ""
        return {
            "given": given,
            "middle": middle if middle != given else "",
            "surname": self.rng.choice(pool["surname"]),
            "birth": self._birth(),
            "nationality": "AU" if self.rng.random() < 0.75 else self.rng.choice(["GB", "NZ", "IN", "CN", "VN", "IE"]),
            "address": self._au_address(),
            "jurisdiction": "AU",
            "origin": origin,
        }

    def _register_people(self, limit: int) -> list[dict[str, Any]]:
        seen: set[tuple[str, str, int, int]] = set()
        people: list[dict[str, Any]] = []
        with CH_PEOPLE.open() as fh:
            for line in fh:
                r = json.loads(line)
                el = r.get("nameElements") or {}
                fore, sur = (el.get("forename") or "").strip(), (el.get("surname") or "").strip()
                if not fore or not sur or not r.get("birthYear"):
                    continue
                key = (fore.lower(), sur.lower(), int(r["birthYear"]), int(r.get("birthMonth") or 0))
                if key in seen:  # the same person often appears as PSC of several companies
                    continue
                seen.add(key)
                # the register publishes month/year only; a day is synthesised deterministically
                day = 1 + sum(map(ord, fore + sur)) % 28
                people.append(
                    {
                        "given": fore.title(),
                        "middle": (el.get("middle_name") or "").strip().title(),
                        "surname": sur.title(),
                        "title": el.get("title") or "",
                        "birth": (int(r["birthYear"]), int(r.get("birthMonth") or 1), day),
                        "nationality": NATIONALITY_TEXT.get(r.get("nationality") or "", ""),
                        "address": {
                            "line1": f"{self.rng.randint(1, 180)} {self.rng.choice(self.names['streets'])} Road",
                            "locality": (r.get("locality") or "").title(),
                            "postcode": (r.get("postalCode") or "").upper(),
                            "country": "GB",
                        },
                        "jurisdiction": COUNTRY_TEXT.get(r.get("countryOfResidence") or "", "GB"),
                        "origin": "uk_register",
                    }
                )
        self.rng.shuffle(people)
        return people[:limit]

    def _synthetic_company(self) -> dict[str, Any]:
        n = self.names
        words = [self.rng.choice(n["company_words"])]
        if self.rng.random() < 0.5:
            words.append(self.rng.choice(n["company_words"]))
        core = " ".join(dict.fromkeys(words)) + " " + self.rng.choice(n["company_kinds"])
        acn = acn_with_check(self.rng)
        return {
            "core": core,
            "form": "Pty Ltd",
            "acn": acn,
            "jurisdiction": "AU",
            "address": self._au_address(),
            "origin": "au_company",
        }

    def _register_companies(self, limit: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if not CH_STRUCTURES.exists():
            return out
        seen: set[str] = set()
        with CH_STRUCTURES.open() as fh:
            for line in fh:
                for psc in json.loads(line).get("pscs", []):
                    d = psc.get("data") or {}
                    if "corporate" not in (d.get("kind") or ""):
                        continue
                    name = (d.get("name") or "").strip()
                    reg = ((d.get("identification") or {}).get("registration_number") or "").strip()
                    if not name or name.lower() in seen:
                        continue
                    seen.add(name.lower())
                    a = d.get("address") or {}
                    form = (
                        "Limited"
                        if name.lower().endswith("limited")
                        else ("Ltd" if name.lower().endswith("ltd") else "")
                    )
                    core = name[: -len(form)].strip() if form else name
                    out.append(
                        {
                            "core": core,
                            "form": form,
                            "uk": reg,
                            "jurisdiction": "GB",
                            "address": {
                                "line1": " ".join(p for p in (a.get("premises"), a.get("address_line_1")) if p),
                                "locality": a.get("locality") or "",
                                "postcode": a.get("postal_code") or "",
                                "country": "GB",
                            },
                            "origin": "uk_register_company",
                        }
                    )
        return out[:limit]

    # ── rendering + perturbation ──────────────────────────────────────────────────────────────────
    def render_person(self, p: dict[str, Any]) -> dict[str, Any]:
        y, m, d = p["birth"]
        parts = [p["given"], p.get("middle") or "", p["surname"]]
        return {
            "kind": "person",
            "name": " ".join(x for x in parts if x),
            "birth_date": f"{y:04d}-{m:02d}-{d:02d}",
            "nationality": p.get("nationality") or None,
            "jurisdiction": p.get("jurisdiction"),
            "identifiers": {},
            "address": dict(p["address"]),
        }

    def render_company(self, c: dict[str, Any]) -> dict[str, Any]:
        ids = {"acn": c["acn"]} if c.get("acn") else ({"ukCompanyNumber": c["uk"]} if c.get("uk") else {})
        return {
            "kind": "company",
            "name": f"{c['core']} {c['form']}".strip(),
            "birth_date": None,
            "nationality": None,
            "jurisdiction": c["jurisdiction"],
            "identifiers": ids,
            "address": dict(c["address"]),
        }

    def _typo(self, word: str) -> str:
        if len(word) < 3:
            return word
        i = self.rng.randint(1, len(word) - 2)
        op = self.rng.choice(["sub", "del", "ins", "swap"])
        letters = string.ascii_lowercase
        if op == "sub":
            return word[:i] + self.rng.choice(letters) + word[i + 1 :]
        if op == "del":
            return word[:i] + word[i + 1 :]
        if op == "ins":
            return word[:i] + self.rng.choice(letters) + word[i:]
        return word[: i - 1] + word[i] + word[i - 1] + word[i + 1 :]

    def perturb_person(self, p: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        q = json.loads(json.dumps(p))
        q["birth"] = list(p["birth"])
        k = int(_weighted(self.rng, self.cfg["perturbations_per_variant"]))
        ops = self.rng.sample(
            [
                "typo_surname",
                "typo_given",
                "nickname",
                "initial",
                "drop_middle",
                "swap_order",
                "honorific",
                "dob_missing",
                "dob_month_year",
                "dob_transposed",
                "dob_day_slip",
                "address_missing",
                "address_format",
                "moved",
                "postcode_missing",
                "nationality_missing",
                "diacritics",
                "case",
                "surname_change",
            ],
            k=k,
        )
        applied: list[str] = []
        render = self.render_person(q)
        for op in ops:
            if op == "surname_change" and self.rng.random() > 0.15:
                continue  # rare: marriage or deed poll (a genuinely hard positive)
            applied.append(op)
            if op == "typo_surname":
                q["surname"] = self._typo(q["surname"]).title()
            elif op == "typo_given":
                q["given"] = self._typo(q["given"]).title()
            elif op == "nickname":
                nick = self.names["nickname_of"].get(q["given"].lower())
                if nick:
                    q["given"] = nick
            elif op == "initial":
                q["given"] = q["given"][0]
            elif op == "drop_middle":
                q["middle"] = ""
            elif op == "surname_change":
                pool = self.names["origins"]["anglo"]["surname"]
                q["surname"] = self.rng.choice(pool)
            elif op == "moved":
                q["address"] = (
                    self._au_address()
                    if q["address"].get("country") == "AU"
                    else {
                        **q["address"],
                        "line1": f"{self.rng.randint(1, 99)} Mill Lane",
                        "postcode": "",
                    }
                )
            render = self.render_person(q)
        for op in applied:
            if op == "swap_order":
                render["name"] = f"{q['surname']} {q['given']}" + (f" {q['middle']}" if q.get("middle") else "")
            elif op == "honorific":
                render["name"] = self.rng.choice(["Mr", "Mrs", "Ms", "Dr"]) + " " + render["name"]
            elif op == "dob_missing":
                render["birth_date"] = None
            elif op == "dob_month_year":
                render["birth_date"] = render["birth_date"][:7] if render["birth_date"] else None
            elif op == "dob_transposed":
                y, m, d = q["birth"]
                if d <= 12 and d != m:
                    render["birth_date"] = f"{y:04d}-{d:02d}-{m:02d}"
            elif op == "dob_day_slip":
                y, m, d = q["birth"]
                render["birth_date"] = f"{y:04d}-{m:02d}-{min(28, max(1, d + self.rng.choice([-1, 1]))):02d}"
            elif op == "address_missing":
                render["address"] = {}
            elif op == "address_format":
                a = render["address"]
                a["line1"] = (
                    (a.get("line1") or "")
                    .replace("Street", "St")
                    .replace("Road", "Rd")
                    .replace("Avenue", "Ave")
                    .upper()
                )
            elif op == "postcode_missing":
                render["address"].pop("postcode", None)
            elif op == "nationality_missing":
                render["nationality"] = None
            elif op == "diacritics":
                table = self.names["diacritics"]
                name = render["name"]
                idx = [i for i, ch in enumerate(name) if ch in table]
                if idx:
                    i = self.rng.choice(idx)
                    render["name"] = name[:i] + table[name[i]] + name[i + 1 :]
            elif op == "case":
                render["name"] = render["name"].upper()
        return render, applied

    def perturb_company(self, c: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        r = self.render_company(c)
        k = int(_weighted(self.rng, self.cfg["perturbations_per_variant"]))
        ops = self.rng.sample(
            [
                "form",
                "case",
                "the",
                "ampersand",
                "typo",
                "id_format",
                "id_missing",
                "abn_instead",
                "address_missing",
                "moved",
                "abbrev",
            ],
            k=k,
        )
        for op in ops:
            if op == "form":
                forms = (
                    ["Pty Ltd", "Proprietary Limited", "PTY. LTD.", "", "Pty. Limited"]
                    if c["jurisdiction"] == "AU"
                    else ["Limited", "Ltd", "LTD", ""]
                )
                r["name"] = f"{c['core']} {self.rng.choice(forms)}".strip()
            elif op == "case":
                r["name"] = r["name"].upper()
            elif op == "the":
                r["name"] = "The " + r["name"]
            elif op == "ampersand":
                r["name"] = (
                    r["name"].replace(" and ", " & ") if " and " in r["name"] else r["name"].replace(" ", " & ", 1)
                )
            elif op == "typo":
                words = r["name"].split()
                i = self.rng.randrange(len(words))
                words[i] = self._typo(words[i])
                r["name"] = " ".join(words)
            elif op == "id_format" and r["identifiers"].get("acn"):
                a = r["identifiers"]["acn"]
                r["identifiers"] = {"acn": f"{a[:3]} {a[3:6]} {a[6:]}"}
            elif op == "id_missing":
                r["identifiers"] = {}
            elif op == "abn_instead" and c.get("acn"):
                r["identifiers"] = {"abn": abn_from_acn(c["acn"])}
            elif op == "address_missing":
                r["address"] = {}
            elif op == "moved":
                r["address"] = (
                    self._au_address()
                    if c["jurisdiction"] == "AU"
                    else {**r["address"], "line1": "1 New Street", "postcode": ""}
                )
            elif op == "abbrev":
                r["name"] = (
                    r["name"]
                    .replace("Developments", "Dev")
                    .replace("Investments", "Inv")
                    .replace("Holdings", "Hldgs")
                    .replace("International", "Intl")
                )
        return r, ops

    # ── build ─────────────────────────────────────────────────────────────────────────────────────
    def build_entities(self) -> list[Entity]:
        cfg = self.cfg["entities"]
        s = self.scale
        people: list[dict[str, Any]] = []
        if self.use_register:
            people = self._register_people(int(cfg["uk_register_people"] * s))
            self.source_note = "Companies House PSC individuals (perturbed) + synthetic AU people and companies"
        else:
            people = [self._synthetic_person("anglo") for _ in range(int(cfg["uk_register_people"] * s * 0.6))]
            self.source_note = "synthetic people and companies only (no Companies House sample in data/)"
        people += [self._synthetic_person() for _ in range(int(cfg["synthetic_people"] * s))]
        companies = [self._synthetic_company() for _ in range(int(cfg["synthetic_companies"] * s))]
        if self.use_register:
            companies += self._register_companies(int(cfg["uk_register_companies"] * s))
        entities: list[Entity] = []
        for i, p in enumerate(people):
            entities.append(Entity(f"p{i}", "person", p["origin"], self._split(), p))
        for i, c in enumerate(companies):
            entities.append(Entity(f"c{i}", "company", c["origin"], self._split(), c))
        # hard negatives as separate entities in the same fold as their look-alike
        extra: list[Entity] = []
        for e in entities:
            r = self.rng.random()
            if e.kind == "person" and r < self.cfg["namesake_share"]:
                twin = json.loads(json.dumps(e.attrs))
                y = e.attrs["birth"][0]
                twin["birth"] = (
                    y + self.rng.choice([-30, -25, -2, -1, 1, 2, 25, 30]),
                    self.rng.randint(1, 12),
                    self.rng.randint(1, 28),
                )
                twin["address"] = self._au_address() if twin["address"].get("country") == "AU" else twin["address"]
                extra.append(Entity(f"{e.eid}-namesake", "person", e.origin, e.split, twin))
            elif e.kind == "person" and r < self.cfg["namesake_share"] + self.cfg["relative_share"]:
                rel = json.loads(json.dumps(e.attrs))
                pool = self.names["origins"].get(e.origin, self.names["origins"]["anglo"])
                choices = [g for g in pool["given_f"] + pool["given_m"] if g != rel["given"]]
                rel["given"] = self.rng.choice(choices)
                rel["middle"] = ""
                y = e.attrs["birth"][0]
                rel["birth"] = (y + self.rng.choice([-28, -3, 2, 30]), self.rng.randint(1, 12), self.rng.randint(1, 28))
                extra.append(Entity(f"{e.eid}-relative", "person", e.origin, e.split, rel))
            elif e.kind == "company" and r < self.cfg["sibling_company_share"]:
                sib = json.loads(json.dumps(e.attrs))
                kinds = [k for k in self.names["company_kinds"] if k not in sib["core"]]
                stem = " ".join(sib["core"].split()[:-1]) or sib["core"]
                sib["core"] = f"{stem} {self.rng.choice(kinds)}"
                if sib.get("acn"):
                    sib["acn"] = acn_with_check(self.rng)
                if sib.get("uk"):
                    sib["uk"] = f"{self.rng.randint(1, 99999999):08d}"
                extra.append(Entity(f"{e.eid}-sibling", "company", e.origin, e.split, sib))
        entities += extra
        for e in entities:
            n_variants = int(_weighted(self.rng, self.cfg["variants_per_entity"]))
            base = self.render_person(e.attrs) if e.kind == "person" else self.render_company(e.attrs)
            e.records = [base]
            for _ in range(n_variants):
                rec, _ops = self.perturb_person(e.attrs) if e.kind == "person" else self.perturb_company(e.attrs)
                e.records.append(rec)
        self.entities = entities
        return entities

    def build_pairs(self) -> tuple[pd.DataFrame, dict[str, Any]]:
        """Feature rows for every blocked pair (within each fold) + blocking statistics."""
        if not self.entities:
            self.build_entities()
        rows: list[dict[str, Any]] = []
        stats: dict[str, Any] = {"source": self.source_note, "folds": {}}
        for split in SPLITS:
            recs: list[dict[str, Any]] = []
            owners: list[Entity] = []
            for e in self.entities:
                if e.split != split:
                    continue
                for r in e.records:
                    recs.append(r)
                    owners.append(e)
            prepared = [prepare(r) for r in recs]
            pairs = candidate_pairs(prepared)
            true_total = sum(len(e.records) * (len(e.records) - 1) // 2 for e in self.entities if e.split == split)
            true_blocked = 0
            for i, j in sorted(pairs):
                same = owners[i].eid == owners[j].eid
                true_blocked += int(same)
                feats = compare(prepared[i], prepared[j])
                rows.append(
                    {
                        **feats,
                        "label": int(same),
                        "split": split,
                        "group": owners[i].eid.split("-")[0],
                        "group_b": owners[j].eid.split("-")[0],
                        "origin": owners[i].origin,
                        "kind": owners[i].kind,
                        "hard_negative": int(not same and owners[i].eid.split("-")[0] == owners[j].eid.split("-")[0]),
                    }
                )
            stats["folds"][split] = {
                "entities": sum(1 for e in self.entities if e.split == split),
                "records": len(recs),
                "pairs": len(pairs),
                "true_pairs": true_total,
                "blocking_recall": round(true_blocked / true_total, 4) if true_total else None,
            }
        df = pd.DataFrame(rows)
        stats["label_counts"] = {k: int(v) for k, v in Counter(df["label"]).items()}
        stats["origins"] = {k: int(v) for k, v in Counter(df["origin"]).items()}
        return df, stats


def feature_matrix(df: pd.DataFrame) -> np.ndarray:
    return df[list(FEATURES)].to_numpy(dtype=float)


def fold(df: pd.DataFrame, name: str) -> pd.DataFrame:
    return df[df["split"] == name].reset_index(drop=True)


def strip_personal(df: pd.DataFrame) -> pd.DataFrame:
    """Columns safe to commit: features, label, fold, coarse origin group. No names, dates or addresses."""
    keep = [*FEATURES, "label", "split", "origin", "kind", "hard_negative"]
    return df[keep].copy()


def fold_name(s: str) -> str:
    return ascii_fold(s)
