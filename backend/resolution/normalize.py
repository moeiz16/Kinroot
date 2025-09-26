"""Normalisation shared by entity resolution, screening and the graph projection (ADR 0003 step 1).

Pure functions, no Django: case-fold, transliterate to ASCII, strip honorifics and legal-form suffixes, canonicalise
identifiers and postcodes, parse partial birth dates.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from functools import lru_cache

import jellyfish

HONORIFICS = frozenset(
    [
        "mr",
        "mrs",
        "ms",
        "miss",
        "mx",
        "dr",
        "prof",
        "sir",
        "dame",
        "lord",
        "lady",
        "hon",
        "honourable",
        "the",
        "rev",
        "reverend",
        "fr",
        "father",
        "sr",
        "jr",
        "ii",
        "iii",
        "iv",
        "esq",
        "qc",
        "kc",
        "sc",
        "am",
        "ao",
        "ac",
        "oam",
        "mp",
        "mla",
        "mlc",
        "sheikh",
    ]
)
LEGAL_SUFFIXES = (
    "proprietary limited", "pty limited", "pty ltd", "pty. ltd.", "pty", "limited", "ltd", "llc", "l.l.c.", "inc",
    "incorporated", "corporation", "corp", "plc", "llp", "lp", "gmbh", "ag", "sa", "s.a.", "bv", "nv", "fze", "fzco",
    "fz-llc", "fzc", "dmcc", "co", "company", "holdings", "holding", "group", "trust", "the trustee for",
    "as trustee for", "atf", "unit trust", "family trust", "partners", "partnership",
)  # fmt: skip
# Suffixes that identify the legal form but are part of the name's identity for display; stripping them for
# matching is what makes "Aurelian Maritime FZE" ~ "Aurelian Maritime FZCO".
FORM_WORDS = frozenset(
    [
        "pty",
        "ltd",
        "limited",
        "llc",
        "inc",
        "incorporated",
        "corporation",
        "corp",
        "plc",
        "llp",
        "lp",
        "gmbh",
        "ag",
        "sa",
        "bv",
        "nv",
        "fze",
        "fzco",
        "fzc",
        "fz",
        "dmcc",
        "co",
        "company",
        "proprietary",
        "atf",
    ]
)
NICKNAMES: dict[str, str] = {
    "ben": "benjamin", "benji": "benjamin", "bill": "william", "will": "william", "liam": "william",
    "bob": "robert", "rob": "robert", "bobby": "robert", "dick": "richard", "rick": "richard", "rich": "richard",
    "jim": "james", "jimmy": "james", "jamie": "james", "mike": "michael", "mick": "michael", "tom": "thomas",
    "tommy": "thomas", "dave": "david", "steve": "stephen", "steven": "stephen", "chris": "christopher",
    "kate": "katherine", "katie": "katherine", "cathy": "catherine", "liz": "elizabeth", "beth": "elizabeth",
    "betty": "elizabeth", "lizzie": "elizabeth", "sue": "susan", "suzy": "susan", "jenny": "jennifer",
    "jen": "jennifer", "alex": "alexander", "sasha": "alexander", "andy": "andrew", "drew": "andrew",
    "tony": "anthony", "joe": "joseph", "joey": "joseph", "sam": "samuel", "matt": "matthew", "nick": "nicholas",
    "pat": "patrick", "peggy": "margaret", "maggie": "margaret", "meg": "margaret", "greg": "gregory",
    "dan": "daniel", "danny": "daniel", "ed": "edward", "eddie": "edward", "ted": "edward", "fred": "frederick",
    "harry": "henry", "hal": "henry", "jack": "john", "johnny": "john", "jon": "jonathan", "larry": "lawrence",
    "len": "leonard", "phil": "philip", "ron": "ronald", "russ": "russell", "sean": "sean", "shaun": "sean",
    "tim": "timothy", "vic": "victor", "abby": "abigail", "allie": "alison", "annie": "anne", "becky": "rebecca",
    "debbie": "deborah", "jo": "joanne", "mandy": "amanda", "nat": "natalie", "pam": "pamela", "penny": "penelope",
    "sally": "sarah", "sandy": "sandra", "terri": "teresa", "trish": "patricia", "val": "valerie", "aleksei": "alexei",
    "alexey": "alexei", "aleksey": "alexei", "mohammed": "muhammad", "mohammad": "muhammad", "mohamed": "muhammad",
}  # fmt: skip

_PUNCT = re.compile(r"[^\w\s&]")
_SPACE = re.compile(r"\s+")
_DIGITS = re.compile(r"\D")


def ascii_fold(text: str) -> str:
    """Transliterate to ASCII (é -> e, ß -> ss) and case-fold."""
    text = text.replace("ß", "ss").replace("æ", "ae").replace("ø", "o").replace("đ", "d").replace("ł", "l")
    norm = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in norm if not unicodedata.combining(ch)).encode("ascii", "ignore").decode().casefold()


@lru_cache(maxsize=65536)
def clean(text: str | None) -> str:
    if not text:
        return ""
    t = ascii_fold(text).replace("&", " and ").replace("'", "").replace("\u2019", "")
    t = _PUNCT.sub(" ", t)
    return _SPACE.sub(" ", t).strip()


@lru_cache(maxsize=65536)
def person_tokens(name: str | None) -> tuple[str, ...]:
    """Name tokens without honorifics; nicknames mapped to their formal form."""
    toks = [t for t in clean(name).split() if t not in HONORIFICS]
    return tuple(NICKNAMES.get(t, t) for t in toks)


@lru_cache(maxsize=65536)
def org_tokens(name: str | None) -> tuple[str, ...]:
    toks = [t for t in clean(name).split() if t not in FORM_WORDS and t != "the"]
    return tuple(toks) or tuple(clean(name).split())


def normalize_name(name: str | None, kind: str = "person") -> str:
    toks = person_tokens(name) if kind == "person" else org_tokens(name)
    return " ".join(toks)


@lru_cache(maxsize=65536)
def double_metaphone_key(token: str) -> str:
    """A compact phonetic key. jellyfish ships Metaphone and NYSIIS; both are combined for robustness."""
    if not token:
        return ""
    return jellyfish.metaphone(token)[:6]


@lru_cache(maxsize=65536)
def nysiis_key(token: str) -> str:
    return jellyfish.nysiis(token)[:8] if token else ""


def surname(name: str | None, kind: str = "person") -> str:
    toks = person_tokens(name) if kind == "person" else org_tokens(name)
    return toks[-1] if toks else ""


def given(name: str | None) -> str:
    toks = person_tokens(name)
    return toks[0] if len(toks) > 1 else ""


def canonical_identifier(value: str | None) -> str:
    """ACN/ABN/UK company numbers: digits only for AU numbers, upper-case alphanumerics otherwise."""
    if not value:
        return ""
    v = re.sub(r"[^0-9A-Za-z]", "", str(value)).upper()
    if v.isdigit() and len(v) in (9, 11):  # ACN / ABN
        return v
    if len(v) < 8 and v.isdigit():  # UK company numbers are zero-padded to 8
        return v.zfill(8)
    return v


def canonical_identifiers(ids: dict[str, str] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in (ids or {}).items():
        c = canonical_identifier(v)
        if c:
            out[k] = c
    return out


def acn_valid(acn: str) -> bool:
    """ASIC check digit for a 9-digit ACN."""
    d = _DIGITS.sub("", acn or "")
    if len(d) != 9:
        return False
    total = sum(int(c) * w for c, w in zip(d[:8], range(8, 0, -1), strict=True))
    return (10 - total % 10) % 10 == int(d[8])


def abn_valid(abn: str) -> bool:
    d = _DIGITS.sub("", abn or "")
    if len(d) != 11:
        return False
    weights = (10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19)
    digits = [int(c) for c in d]
    digits[0] -= 1
    return sum(a * b for a, b in zip(digits, weights, strict=True)) % 89 == 0


# ── Dates ──────────────────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class PartialDate:
    year: int | None = None
    month: int | None = None
    day: int | None = None

    @property
    def empty(self) -> bool:
        return self.year is None


def parse_partial_date(value: date | str | None) -> PartialDate:
    if value is None or value == "":
        return PartialDate()
    if isinstance(value, date):
        return PartialDate(value.year, value.month, value.day)
    m = re.match(r"^\s*(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?", str(value))
    if not m:
        return PartialDate()
    y, mo, d = m.groups()
    return PartialDate(int(y), int(mo) if mo else None, int(d) if d else None)


# ── Addresses ──────────────────────────────────────────────────────────────────────────────────────
ADDRESS_ABBREV = {
    "street": "st", "road": "rd", "avenue": "ave", "av": "ave", "drive": "dr", "place": "pl", "lane": "ln",
    "court": "ct", "parade": "pde", "highway": "hwy", "terrace": "tce", "crescent": "cres", "boulevard": "blvd",
    "suite": "ste", "level": "lvl", "unit": "u", "apartment": "apt", "floor": "fl", "north": "n", "south": "s",
    "east": "e", "west": "w", "saint": "st", "mount": "mt",
}  # fmt: skip


def address_text(address: dict[str, str] | str | None) -> str:
    """Human-readable single line from the Party.address dict ({line1, locality, state|region, postcode, country})."""
    if not address:
        return ""
    if isinstance(address, str):
        return address.strip()
    parts = [
        address.get("line1") or "",
        address.get("line2") or "",
        " ".join(
            p
            for p in (
                address.get("locality") or "",
                address.get("state") or address.get("region") or "",
                address.get("postcode") or address.get("postCode") or "",
            )
            if p
        ),
        address.get("country") or "",
    ]
    return ", ".join(p.strip() for p in parts if p and p.strip())


def address_tokens(address: dict[str, str] | str | None) -> tuple[str, ...]:
    toks = clean(address_text(address)).split()
    return tuple(ADDRESS_ABBREV.get(t, t) for t in toks)


def postcode_of(address: dict[str, str] | str | None) -> str:
    if isinstance(address, dict):
        pc = address.get("postcode") or address.get("postCode") or ""
        return re.sub(r"\s", "", pc).upper()
    if isinstance(address, str):
        m = re.search(r"\b(\d{4})\b|\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b", address.upper())
        if m:
            return re.sub(r"\s", "", m.group(0))
    return ""


def address_key(org_id: str, address: dict[str, str] | str | None) -> str | None:
    """Stable id of an address node: identical normalised addresses in one org share a node."""
    toks = address_tokens(address)
    if not toks:
        return None
    digest = hashlib.sha1(f"{org_id}|{' '.join(toks)}".encode(), usedforsecurity=False).hexdigest()[:16]
    return f"addr:{digest}"
