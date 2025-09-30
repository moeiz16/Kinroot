"""Sanctions / PEP name matching with corroboration (pure, no Django).

Score = best name similarity over the entry's names and aliases (normalised: transliteration, honorifics and
legal forms removed, common transliteration variants folded), adjusted by secondary identifiers:
birth date (exact +0.06, same year +0.03, different year -0.10, or -0.20 when both sides have full dates) and
country (shared nationality/country +0.03, disjoint -0.05). Names drive alerting; a strong identifier
mismatch can suppress an alert, a weak one only lowers it. Every adjustment is returned as a plain reason.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, cast

from rapidfuzz.distance import Indel, JaroWinkler

from kinroot.contracts import MatchReason
from resolution.features import nationality_code
from resolution.normalize import double_metaphone_key, org_tokens, parse_partial_date, person_tokens

PERSON_SCHEMAS = frozenset({"Person"})
NAME_FLOOR = 0.80
DEFAULT_THRESHOLD = 0.82


@dataclass
class Entry:
    id: str
    list_kind: str
    schema: str
    name: str
    aliases: list[str] = field(default_factory=list)
    birth_date: str = ""
    countries: list[str] = field(default_factory=list)
    programs: list[str] = field(default_factory=list)
    pk: int | None = None  # database row id

    @property
    def is_person(self) -> bool:
        return self.schema in PERSON_SCHEMAS


# Generic words carry no identity in company names ("Cayman Ridge Holdings" is not "Caspian Bridge Holdings").
GENERIC_ORG_WORDS = frozenset(
    [
        "holdings",
        "holding",
        "group",
        "investments",
        "investment",
        "capital",
        "trading",
        "international",
        "services",
        "ventures",
        "partners",
        "enterprises",
        "global",
        "management",
        "properties",
        "property",
        "logistics",
        "shipping",
        "finance",
        "financial",
        "resources",
        "industries",
        "solutions",
        "consulting",
        "development",
        "developments",
        "and",
        "of",
    ]
)


def tokens_for(name: str, person: bool) -> tuple[str, ...]:
    if person:
        return person_tokens(name)
    toks = org_tokens(name)
    distinctive = tuple(t for t in toks if t not in GENERIC_ORG_WORDS)
    return distinctive or toks


def token_similarity(x: str, y: str) -> float:
    if x == y:
        return 1.0
    if len(x) == 1 or len(y) == 1:  # an initial
        return 0.9 if x[0] == y[0] else 0.0
    return 0.5 * JaroWinkler.similarity(x, y) + 0.5 * Indel.normalized_similarity(x, y)


def name_similarity(a: tuple[str, ...], b: tuple[str, ...]) -> float:
    """Token-aligned similarity: every token of the shorter name is paired with its best distinct partner in the
    longer one (order-free, so "Kwon Chol Jin" == "Chol Jin Kwon"); unmatched extra tokens (a middle name)
    cost a little. Blending Jaro-Winkler with an edit ratio keeps "Ellis" and "Ellison" apart."""
    if not a or not b:
        return 0.0
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    remaining = list(long_)
    total = 0.0
    for t in sorted(short, key=len, reverse=True):
        best_i, best = 0, -1.0
        for i, u in enumerate(remaining):
            s = token_similarity(t, u)
            if s > best:
                best_i, best = i, s
        total += max(0.0, best)
        remaining.pop(best_i)
    sim = total / len(short) - 0.04 * (len(long_) - len(short))
    if len(short) == 1 and len(long_) > 1:  # a single word against a full name is weak evidence
        sim -= 0.15
    return float(max(0.0, min(1.0, sim)))


class ListIndex:
    """Phonetic token index over every name and alias of the loaded entries."""

    def __init__(self, entries: list[Entry]) -> None:
        self.entries = entries
        self.names: list[list[tuple[str, ...]]] = []
        self.index: dict[str, set[int]] = defaultdict(set)
        for i, e in enumerate(entries):
            variants = [tokens_for(n, e.is_person) for n in [e.name, *e.aliases] if n]
            self.names.append(variants)
            for toks in variants:
                for t in toks:
                    if len(t) >= 3:
                        self.index[double_metaphone_key(t)].add(i)

    def candidates(self, toks: tuple[str, ...]) -> set[int]:
        out: set[int] = set()
        for t in toks:
            if len(t) >= 3:
                out |= self.index.get(double_metaphone_key(t), set())
        return out

    def __len__(self) -> int:
        return len(self.entries)


def _get(rec: Any, key: str) -> Any:
    return rec.get(key) if isinstance(rec, dict) else getattr(rec, key, None)


def score_entry(
    record: Any, entry: Entry, variants: list[tuple[str, ...]] | None = None
) -> tuple[float, list[MatchReason]]:
    person = (_get(record, "kind") or "person") == "person"
    toks = tokens_for(_get(record, "name") or "", person)
    variants = (
        variants if variants is not None else [tokens_for(n, entry.is_person) for n in [entry.name, *entry.aliases]]
    )
    best, best_name = 0.0, entry.name
    for i, v in enumerate(variants):
        s = name_similarity(toks, v)
        if s > best:
            best, best_name = s, ([entry.name, *entry.aliases])[i]
    reasons: list[MatchReason] = []
    is_alias = best_name != entry.name
    if best >= 0.97:
        label = f"Name matches the listed {'alias' if is_alias else 'name'} “{best_name}”"
    elif best >= 0.9:
        label = f"Name is a close variant of the listed {'alias' if is_alias else 'name'} “{best_name}”"
    else:
        label = f"Name is similar to “{best_name}”"
    reasons.append(
        MatchReason(
            feature="name_similarity", label=label, direction="for", contribution=round(best, 4), value=f"{best:.2f}"
        )
    )
    score = best

    a = parse_partial_date(_get(record, "birth_date"))
    b = parse_partial_date(entry.birth_date or None)
    if person and not a.empty and not b.empty:
        full = a.day is not None and b.day is not None
        if full and (a.year, a.month, a.day) == (b.year, b.month, b.day):
            delta, label, d = 0.06, "Same date of birth", "for"
        elif a.year == b.year:
            delta, label, d = 0.03, f"Same birth year ({a.year})", "for"
        elif abs((a.year or 0) - (b.year or 0)) <= 1:
            delta, label, d = 0.0, f"Birth years one apart ({a.year} vs {b.year})", "against"
        else:
            delta = -0.20 if full else -0.10
            label, d = f"Different birth year ({a.year} vs {b.year})", "against"
        score += delta
        reasons.append(
            MatchReason(
                feature="birth_date",
                label=label,
                direction=cast(Any, d),
                contribution=delta,
                value=f"{a.year} / {b.year}",
            )
        )
    elif person:
        reasons.append(
            MatchReason(
                feature="birth_date",
                label="No birth date to compare",
                direction="against",
                contribution=0.0,
                value="missing",
            )
        )

    ours = {
        c
        for c in (nationality_code(_get(record, "nationality")), (_get(record, "jurisdiction") or "").upper()[:2])
        if c
    }
    theirs = {c.upper()[:2] for c in entry.countries if c}
    if ours and theirs:
        if ours & theirs:
            score += 0.03
            reasons.append(
                MatchReason(
                    feature="country",
                    label=f"Same country ({', '.join(sorted(ours & theirs))})",
                    direction="for",
                    contribution=0.03,
                    value="same",
                )
            )
        else:
            score -= 0.05
            reasons.append(
                MatchReason(
                    feature="country",
                    label=f"Different country ({', '.join(sorted(ours))} vs {', '.join(sorted(theirs))})",
                    direction="against",
                    contribution=-0.05,
                    value="different",
                )
            )
    return round(max(0.0, min(1.0, score)), 4), reasons


def screen(
    index: ListIndex, record: Any, *, threshold: float = DEFAULT_THRESHOLD
) -> list[tuple[Entry, float, list[MatchReason]]]:
    person = (_get(record, "kind") or "person") == "person"
    toks = tokens_for(_get(record, "name") or "", person)
    hits = []
    for i in index.candidates(toks):
        e = index.entries[i]
        if e.is_person != person:
            continue
        if max((name_similarity(toks, v) for v in index.names[i]), default=0.0) < NAME_FLOOR:
            continue
        s, reasons = score_entry(record, e, index.names[i])
        if s >= threshold:
            hits.append((e, s, reasons))
    hits.sort(key=lambda h: (-h[1], h[0].id))
    return hits
