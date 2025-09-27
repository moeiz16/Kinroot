"""Jurisdiction reference sets used by graph flags and risk rules.

Both sets are illustrative snapshots for the demo methodology and should be maintained by the firm (they are
inputs to a versioned risk methodology, not hard-coded truths):

- OFFSHORE: secrecy / offshore financial centres commonly used for holding layers.
- HIGH_RISK: jurisdictions subject to a FATF call for action or under increased monitoring, per the FATF public
  statements available in October 2025.
"""

from __future__ import annotations

OFFSHORE: frozenset[str] = frozenset(
    {
        "VG",
        "KY",
        "BM",
        "SC",
        "PA",
        "BS",
        "JE",
        "GG",
        "IM",
        "LI",
        "MH",
        "BZ",
        "VU",
        "WS",
        "AE",
        "CW",
        "AI",
        "TC",
        "MU",
        "NR",
    }
)

HIGH_RISK: frozenset[str] = frozenset(
    {
        # call for action
        "KP", "IR", "MM",
        # increased monitoring
        "DZ", "AO", "BO", "BG", "CM", "CI", "CD", "HT", "KE", "LA", "LB", "MC", "NA", "NP", "SS", "SY", "VE",
        "VN", "VG", "YE",
    }
)  # fmt: skip

COUNTRY_NAMES: dict[str, str] = {
    "AU": "Australia",
    "GB": "United Kingdom",
    "NZ": "New Zealand",
    "VG": "British Virgin Islands",
    "KY": "Cayman Islands",
    "SC": "Seychelles",
    "AE": "United Arab Emirates",
    "SG": "Singapore",
    "HK": "Hong Kong",
    "JP": "Japan",
    "US": "United States",
    "BM": "Bermuda",
    "PA": "Panama",
    "JE": "Jersey",
    "GG": "Guernsey",
    "IM": "Isle of Man",
    "RU": "Russia",
    "IR": "Iran",
    "KP": "North Korea",
    "MM": "Myanmar",
    "CN": "China",
    "IN": "India",
    "IE": "Ireland",
    "CY": "Cyprus",
    "MT": "Malta",
    "LU": "Luxembourg",
    "CH": "Switzerland",
}


def country_name(code: str | None) -> str:
    if not code:
        return ""
    return COUNTRY_NAMES.get(code.upper(), code.upper())


def is_offshore(code: str | None) -> bool:
    return bool(code) and code.upper() in OFFSHORE  # type: ignore[union-attr]


def is_high_risk(code: str | None) -> bool:
    return bool(code) and code.upper() in HIGH_RISK  # type: ignore[union-attr]
