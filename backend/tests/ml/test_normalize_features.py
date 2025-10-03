"""Normalisation and pairwise comparison features (ADR 0003 steps 1-3)."""

from __future__ import annotations

from datetime import date

import pytest

from resolution.features import FEATURES, compare, nationality_code, prepare
from resolution.normalize import (
    abn_valid,
    acn_valid,
    address_key,
    canonical_identifier,
    normalize_name,
    parse_partial_date,
    person_tokens,
)


def P(name, **kw):
    return {"kind": kw.pop("kind", "person"), "name": name, **kw}


def test_person_tokens_strip_honorifics_and_map_nicknames():
    assert person_tokens("Hon. Ben Okafor") == ("benjamin", "okafor")
    assert person_tokens("Mr Aleksei PETROV") == ("alexei", "petrov")


def test_org_names_drop_legal_forms():
    assert (
        normalize_name("Aurelian Maritime FZE", "company")
        == normalize_name("Aurelian Maritime FZCO", "company")
        == "aurelian maritime"
    )
    assert normalize_name("Bellmere Holdings Pty Ltd", "company") == normalize_name(
        "BELLMERE HOLDINGS PROPRIETARY LIMITED", "company"
    )


def test_transliteration_folds_accents():
    assert person_tokens("José Müller") == ("jose", "muller")


def test_identifier_canonicalisation_and_check_digits():
    assert canonical_identifier("612 345 678") == "612345678"
    assert canonical_identifier("1234567") == "01234567"
    assert acn_valid("004 085 616") and not acn_valid("004 085 617")
    assert abn_valid("53 004 085 616") and not abn_valid("53 004 085 617")


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1971", (1971, None, None)),
        ("1971-04", (1971, 4, None)),
        (date(1971, 4, 9), (1971, 4, 9)),
        (None, (None, None, None)),
    ],
)
def test_partial_dates(value, expected):
    d = parse_partial_date(value)
    assert (d.year, d.month, d.day) == expected


def test_feature_vector_has_stable_ids():
    f = compare(P("Ava Calder"), P("Ava Calder"))
    assert tuple(f) == FEATURES


def test_identical_people_agree_everywhere_present():
    a = P(
        "Ava Calder",
        birth_date="1972-04-09",
        nationality="AU",
        jurisdiction="AU",
        address={"line1": "1 George St", "postcode": "2000"},
    )
    f = compare(a, dict(a))
    assert (
        f["name_jaro_winkler"] == 1.0
        and f["dob_exact"] == 1
        and f["postcode_agree"] == 1
        and f["address_token_overlap"] == 1.0
    )


def test_missing_values_are_minus_one():
    f = compare(P("Ava Calder"), P("Ava Calder"))
    assert (
        f["dob_exact"] == -1
        and f["id_agree"] == -1
        and f["address_token_overlap"] == -1
        and f["nationality_agree"] == -1
    )


def test_transposed_day_and_month():
    f = compare(P("Sam Lee", birth_date="1980-03-07"), P("Sam Lee", birth_date="1980-07-03"))
    assert f["dob_exact"] == 0 and f["dob_transposed"] == 1


def test_nickname_and_swapped_order():
    f = compare(P("Benjamin Okafor"), P("Okafor Ben"))
    assert f["name_jaro_winkler"] >= 0.95 and f["given_name_agree"] >= 0.5


def test_acn_inside_abn_counts_as_identifier_agreement():
    a = {"kind": "company", "name": "Bellmere Holdings Pty Ltd", "identifiers": {"acn": "004 085 616"}}
    b = {"kind": "company", "name": "Bellmere Holdings", "identifiers": {"abn": "53 004 085 616"}}
    assert compare(a, b)["id_agree"] == 1


def test_different_company_numbers_disagree():
    a = {"kind": "company", "name": "Bellmere Holdings", "identifiers": {"acn": "004085616"}}
    b = {"kind": "company", "name": "Bellmere Holdings", "identifiers": {"acn": "612345678"}}
    assert compare(a, b)["id_agree"] == 0


def test_nationality_codes_from_words():
    assert nationality_code("British") == "GB" and nationality_code("au") == "AU" and nationality_code(None) == ""


def test_prepare_is_reusable():
    p = prepare(P("Ava Calder", birth_date="1972-04-09"))
    assert compare(p, p)["dob_exact"] == 1


def test_address_key_ignores_formatting():
    a = address_key("org", {"line1": "88 Victoria Street", "locality": "Mahe", "country": "SC"})
    b = address_key("org", {"line1": "88 VICTORIA ST", "locality": "mahe", "country": "SC"})
    assert a == b and a.startswith("addr:")
    assert address_key("org", {}) is None
    assert address_key("other-org", {"line1": "88 Victoria Street", "locality": "Mahe", "country": "SC"}) != a
