"""SHAP contributions -> plain-language match reasons (ADR 0003 step 7).

Labels describe the evidence ("Same date of birth"), never the model. Direction is whether the evidence pushed
the score towards a match ("for") or away from it ("against").
"""

from __future__ import annotations

from kinroot.contracts import MatchReason


def _sim(v: float, hi: str, mid: str, lo: str, missing: str) -> str:
    if v < 0:
        return missing
    return hi if v >= 0.95 else (mid if v >= 0.85 else lo)


def _flag(v: float, agree: str, disagree: str, missing: str) -> str:
    if v < 0:
        return missing
    return agree if v >= 1 else disagree


LABELS = {
    "name_jaro_winkler": lambda v: _sim(
        v, "Names are almost identical", "Names are similar", "Names are spelled differently", "A name is missing"
    ),
    "name_token_set": lambda v: _sim(
        v, "Same name words", "Most name words match", "Name words differ", "A name is missing"
    ),
    "name_phonetic_agree": lambda v: _flag(v, "Names sound the same", "Names sound different", "A name is missing"),
    "surname_jaro_winkler": lambda v: _sim(
        v, "Same family name", "Similar family names", "Different family names", "A family name is missing"
    ),
    "given_name_agree": lambda v: (
        "Given name missing on one record"
        if v < 0
        else (
            "Same given name"
            if v >= 1
            else (
                "Given names are close variants"
                if v >= 0.75
                else ("Given name matches an initial" if v >= 0.5 else "Different given names")
            )
        )
    ),
    "dob_exact": lambda v: _flag(
        v, "Same date of birth", "Different dates of birth", "Full date of birth not on both records"
    ),
    "dob_partial": lambda v: _flag(
        v, "Same month and year of birth", "Different month or year of birth", "Birth date missing on one record"
    ),
    "dob_transposed": lambda v: _flag(
        v,
        "Day and month of birth look swapped",
        "Birth dates are not a day-month swap",
        "Birth date missing on one record",
    ),
    "dob_year_diff": lambda v: (
        "Birth year missing on one record"
        if v < 0
        else (
            "Same birth year"
            if v == 0
            else (f"Birth years differ by {int(v)} year{'s' if v != 1 else ''}" if v < 10 else "Birth years far apart")
        )
    ),
    "id_agree": lambda v: _flag(
        v, "Same company or registration number", "Different company numbers", "No shared identifier to compare"
    ),
    "address_token_overlap": lambda v: (
        "Address missing on one record"
        if v < 0
        else ("Same address" if v >= 0.6 else ("Addresses partly match" if v >= 0.3 else "Different addresses"))
    ),
    "postcode_agree": lambda v: _flag(v, "Same postcode", "Different postcodes", "Postcode missing on one record"),
    "nationality_agree": lambda v: _flag(
        v, "Same nationality", "Different nationality", "Nationality missing on one record"
    ),
    "jurisdiction_agree": lambda v: _flag(v, "Same country", "Different country", "Country missing on one record"),
    "kind_agree": lambda v: "Same type of party" if v >= 1 else "Different types of party",
}


def value_text(feature: str, v: float) -> str:
    if v < 0:
        return "missing"
    if feature in ("name_jaro_winkler", "name_token_set", "surname_jaro_winkler", "address_token_overlap"):
        return f"{v:.2f}"
    if feature == "dob_year_diff":
        return f"{int(v)}"
    if feature == "given_name_agree":
        return {1.0: "same", 0.75: "variant", 0.5: "initial", 0.0: "different"}.get(v, f"{v:.2f}")
    return "same" if v >= 1 else "different"


def reasons(features: dict[str, float], contributions: dict[str, float], *, top: int = 5) -> list[MatchReason]:
    ranked = sorted(
        ((f, c) for f, c in contributions.items() if f in LABELS and abs(c) > 1e-6),
        key=lambda fc: (-abs(fc[1]), fc[0]),
    )[:top]
    return [
        MatchReason(
            feature=f,
            label=LABELS[f](features.get(f, -1.0)),
            direction="for" if c > 0 else "against",
            contribution=round(float(c), 4),
            value=value_text(f, features.get(f, -1.0)),
        )
        for f, c in ranked
    ]
