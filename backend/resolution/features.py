"""Pairwise comparison features for entity resolution (ADR 0003 step 3). Pure, deterministic, no Django.

Feature ids are stable (they appear in the API, SHAP reasons, model artifacts and the eval). Values:
similarities in 0..1; agreement flags 1 = agree, 0 = disagree, -1 = missing on at least one side.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

import jellyfish
from rapidfuzz import fuzz
from rapidfuzz.distance import JaroWinkler

from .normalize import (
    PartialDate,
    address_tokens,
    canonical_identifiers,
    clean,
    double_metaphone_key,
    nysiis_key,
    org_tokens,
    parse_partial_date,
    person_tokens,
    postcode_of,
)

FEATURES: tuple[str, ...] = (
    "name_jaro_winkler",
    "name_token_set",
    "name_phonetic_agree",
    "surname_jaro_winkler",
    "given_name_agree",
    "dob_exact",
    "dob_partial",
    "dob_transposed",
    "dob_year_diff",
    "id_agree",
    "address_token_overlap",
    "postcode_agree",
    "nationality_agree",
    "jurisdiction_agree",
    "kind_agree",
)
MISSING = -1.0

NATIONALITY_ALIASES = {
    "british": "GB", "english": "GB", "scottish": "GB", "welsh": "GB", "northern irish": "GB", "united kingdom": "GB",
    "uk": "GB", "australian": "AU", "australia": "AU", "irish": "IE", "american": "US", "new zealander": "NZ",
    "indian": "IN", "chinese": "CN", "german": "DE", "french": "FR", "italian": "IT", "polish": "PL",
    "spanish": "ES", "portuguese": "PT", "dutch": "NL", "canadian": "CA", "south african": "ZA", "japanese": "JP",
    "russian": "RU", "greek": "GR", "romanian": "RO", "lithuanian": "LT", "pakistani": "PK", "nigerian": "NG",
    "vietnamese": "VN", "korean": "KR", "singaporean": "SG", "filipino": "PH", "malaysian": "MY", "turkish": "TR",
}  # fmt: skip


def nationality_code(value: str | None) -> str:
    if not value:
        return ""
    v = value.strip()
    if len(v) == 2 and v.isalpha():
        return v.upper()
    return NATIONALITY_ALIASES.get(clean(v), "")


@dataclass
class Prepared:
    """A record with everything the comparators need precomputed once."""

    kind: str
    tokens: tuple[str, ...]
    joined: str
    sorted_joined: str
    surname: str
    given: str
    phon_surname: str
    phon_given: str
    nysiis_surname: str
    dob: PartialDate
    identifiers: dict[str, str]
    address: tuple[str, ...]
    postcode: str
    nationality: str
    jurisdiction: str
    extra: dict[str, Any] = field(default_factory=dict)


def _get(rec: Any, key: str) -> Any:
    if isinstance(rec, dict):
        return rec.get(key)
    return getattr(rec, key, None)


def prepare(rec: Any) -> Prepared:
    kind = (_get(rec, "kind") or "person").lower()
    name = _get(rec, "name") or ""
    person = kind == "person"
    toks = person_tokens(name) if person else org_tokens(name)
    joined = " ".join(toks)
    surname_tok = (toks[-1] if person else toks[0]) if toks else ""
    given_tok = toks[0] if person and len(toks) > 1 else ""
    dob = _get(rec, "birth_date")
    address = _get(rec, "address")
    return Prepared(
        kind=kind,
        tokens=toks,
        joined=joined,
        sorted_joined=" ".join(sorted(toks)),
        surname=surname_tok,
        given=given_tok,
        phon_surname=double_metaphone_key(surname_tok),
        phon_given=double_metaphone_key(given_tok),
        nysiis_surname=nysiis_key(surname_tok),
        dob=parse_partial_date(dob if isinstance(dob, date | str) or dob is None else str(dob)),
        identifiers=canonical_identifiers(_get(rec, "identifiers")),
        address=address_tokens(address),
        postcode=postcode_of(address),
        nationality=nationality_code(_get(rec, "nationality")),
        jurisdiction=(_get(rec, "jurisdiction") or "").upper()[:2],
    )


def _flag(a: Any, b: Any) -> float:
    if not a or not b:
        return MISSING
    return 1.0 if a == b else 0.0


def _given_agree(a: Prepared, b: Prepared) -> float:
    if a.kind != "person" or b.kind != "person":
        return MISSING
    ga = list(a.tokens[:-1])
    gb = list(b.tokens[:-1])
    if not ga or not gb:
        return MISSING
    if ga[0] == gb[0] or set(ga) & set(gb) - {t for t in ga if len(t) == 1}:
        return 1.0
    # initials compatible ("J" vs "John"), or name order swapped
    if (len(ga[0]) == 1 and gb[0].startswith(ga[0])) or (len(gb[0]) == 1 and ga[0].startswith(gb[0])):
        return 0.5
    if a.surname and a.surname in gb and b.surname in ga:
        return 0.5
    if JaroWinkler.similarity(ga[0], gb[0]) >= 0.9:
        return 0.75
    return 0.0


def _dob_features(a: PartialDate, b: PartialDate) -> tuple[float, float, float, float]:
    if a.empty or b.empty:
        return MISSING, MISSING, MISSING, MISSING
    year_diff = float(min(10, abs((a.year or 0) - (b.year or 0))))
    if a.month is None or b.month is None:
        partial = 1.0 if a.year == b.year else 0.0
        return MISSING, partial, MISSING, year_diff
    partial = 1.0 if (a.year, a.month) == (b.year, b.month) else 0.0
    if a.day is None or b.day is None:
        return MISSING, partial, MISSING, year_diff
    exact = 1.0 if (a.year, a.month, a.day) == (b.year, b.month, b.day) else 0.0
    transposed = 1.0 if (not exact and a.year == b.year and a.month == b.day and a.day == b.month) else 0.0
    return exact, partial, transposed, year_diff


def _id_agree(a: dict[str, str], b: dict[str, str]) -> float:
    shared = set(a) & set(b)
    if not shared:
        # ACN is embedded in an ABN (last 9 digits): treat as comparable
        acn = a.get("acn") or b.get("acn")
        abn = b.get("abn") if a.get("acn") else a.get("abn")
        if acn and abn:
            return 1.0 if abn.endswith(acn) else 0.0
        return MISSING
    return 1.0 if any(a[k] == b[k] for k in shared) else 0.0


def _address_overlap(a: tuple[str, ...], b: tuple[str, ...]) -> float:
    if not a or not b:
        return MISSING
    sa, sb = set(a), set(b)
    return round(len(sa & sb) / len(sa | sb), 4)


def _phonetic(a: Prepared, b: Prepared) -> float:
    if not a.surname or not b.surname:
        return MISSING
    surname_ok = a.phon_surname == b.phon_surname or a.nysiis_surname == b.nysiis_surname
    if a.kind == "person" and b.kind == "person" and a.given and b.given:
        given_ok = a.phon_given == b.phon_given or a.given[0] == b.given[0]
        return 1.0 if surname_ok and given_ok else 0.0
    return 1.0 if surname_ok else 0.0


def compare(left: Any, right: Any) -> dict[str, float]:
    a = left if isinstance(left, Prepared) else prepare(left)
    b = right if isinstance(right, Prepared) else prepare(right)
    if a.joined and b.joined:
        jw = max(JaroWinkler.similarity(a.joined, b.joined), JaroWinkler.similarity(a.sorted_joined, b.sorted_joined))
        ts = fuzz.token_set_ratio(a.joined, b.joined) / 100.0
    else:
        jw, ts = MISSING, MISSING
    sjw = JaroWinkler.similarity(a.surname, b.surname) if a.surname and b.surname else MISSING
    exact, partial, transposed, year_diff = _dob_features(a.dob, b.dob)
    feats = {
        "name_jaro_winkler": round(jw, 4),
        "name_token_set": round(ts, 4),
        "name_phonetic_agree": _phonetic(a, b),
        "surname_jaro_winkler": round(sjw, 4),
        "given_name_agree": _given_agree(a, b),
        "dob_exact": exact,
        "dob_partial": partial,
        "dob_transposed": transposed,
        "dob_year_diff": year_diff,
        "id_agree": _id_agree(a.identifiers, b.identifiers),
        "address_token_overlap": _address_overlap(a.address, b.address),
        "postcode_agree": _flag(a.postcode, b.postcode),
        "nationality_agree": _flag(a.nationality, b.nationality),
        "jurisdiction_agree": _flag(a.jurisdiction, b.jurisdiction),
        "kind_agree": 1.0 if a.kind == b.kind else 0.0,
    }
    return feats


def vector(feats: dict[str, float]) -> list[float]:
    return [float(feats[f]) for f in FEATURES]


def soundex_key(token: str) -> str:
    return jellyfish.soundex(token) if token else ""
