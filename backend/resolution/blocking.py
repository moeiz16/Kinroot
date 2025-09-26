"""Blocking (ADR 0003 step 2): candidate pairs must share at least one cheap key, so scoring stays near-linear.

Keys: phonetic surname + birth year (two phonetic codes), phonetic surname + first initial, postcode + initial,
any canonical identifier, organisation first-token phonetic + jurisdiction, organisation name prefix.
Blocking recall (true matches that share a key) is measured in the eval.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from itertools import combinations

from .features import Prepared
from .normalize import double_metaphone_key

MAX_BLOCK = 250  # very common keys (e.g. "Smith" + 1970) are capped; other keys still pair true matches


def block_keys(p: Prepared) -> set[str]:
    keys: set[str] = set()
    for k, v in p.identifiers.items():
        keys.add(f"id|{k}|{v}")
        if k == "abn" and len(v) == 11:
            keys.add(f"id|acn|{v[2:]}")
    if p.kind == "person":
        if p.phon_surname:
            if p.dob.year:
                keys.add(f"ps|{p.phon_surname}|{p.dob.year}")
                keys.add(f"ny|{p.nysiis_surname}|{p.dob.year}")
            if p.given:
                keys.add(f"pi|{p.phon_surname}|{p.given[0]}")
        if p.dob.year and p.dob.month:
            # order-invariant: any name token + month/year (catches "Smith John", changed or misspelled surnames)
            for tok in p.tokens:
                if len(tok) > 1:
                    keys.add(f"td|{double_metaphone_key(tok)}|{p.dob.year}-{p.dob.month}")
        if p.phon_given and len(p.surname) >= 3:
            keys.add(f"gs|{p.phon_given}|{p.surname[:3]}")  # "Murray Chen" / "Murray Cheng", any birth date
        if p.postcode and p.tokens:
            keys.add(f"pc|{p.postcode}|{p.tokens[0][0]}")
    else:
        if p.surname:
            keys.add(f"of|{p.phon_surname}|{p.jurisdiction}")
        if len(p.joined) >= 4:
            keys.add(f"on|{p.joined[:5]}")
    return keys


def candidate_pairs(records: Sequence[Prepared], *, only_touching: set[int] | None = None) -> set[tuple[int, int]]:
    """Index pairs (i < j) of records sharing a block key; persons only pair with persons, entities with entities.
    With `only_touching`, keep pairs where at least one side is in that set (incremental resolution)."""
    buckets: dict[str, list[int]] = defaultdict(list)
    for i, p in enumerate(records):
        for k in block_keys(p):
            buckets[k].append(i)
    pairs: set[tuple[int, int]] = set()
    for members in buckets.values():
        if len(members) < 2 or len(members) > MAX_BLOCK:
            continue
        for i, j in combinations(sorted(members), 2):
            if (records[i].kind == "person") != (records[j].kind == "person"):
                continue
            if only_touching is not None and i not in only_touching and j not in only_touching:
                continue
            pairs.add((i, j))
    return pairs
