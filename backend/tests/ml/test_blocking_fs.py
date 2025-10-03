"""Blocking and the Fellegi-Sunter EM baseline."""

from __future__ import annotations

import numpy as np

from resolution.blocking import block_keys, candidate_pairs
from resolution.features import compare, prepare
from resolution.fellegi_sunter import FellegiSunter, levels


def recs(*names, **kw):
    return [
        prepare({"kind": kw.get("kind", "person"), "name": n, "birth_date": kw.get("dob", "1980-05-06")}) for n in names
    ]


def test_swapped_order_and_typos_share_a_block():
    r = recs("John Smith", "Smith John", "Jon Smith")
    assert candidate_pairs(r) == {(0, 1), (0, 2), (1, 2)}


def test_people_never_pair_with_companies():
    r = [
        prepare({"kind": "person", "name": "Kestrel Smith"}),
        prepare({"kind": "company", "name": "Kestrel Smith Pty Ltd"}),
    ]
    assert candidate_pairs(r) == set()


def test_only_touching_limits_pairs():
    r = recs("Ann Lee", "Ann Lee", "Ann Lee")
    assert candidate_pairs(r, only_touching={2}) == {(0, 2), (1, 2)}


def test_identifier_key_links_acn_and_abn():
    a = prepare({"kind": "company", "name": "Totally Different", "identifiers": {"acn": "004085616"}})
    b = prepare({"kind": "company", "name": "Other Name", "identifiers": {"abn": "53004085616"}})
    assert block_keys(a) & block_keys(b)


def test_given_name_and_surname_prefix_key_survives_different_dates():
    a = prepare({"kind": "person", "name": "Murray Chen", "birth_date": "1975-03-02"})
    b = prepare({"kind": "person", "name": "Murray Cheng", "birth_date": "1981-11-19"})
    assert block_keys(a) & block_keys(b)


def _synthetic_pairs(n=600, seed=0):
    rng = np.random.default_rng(seed)
    rows, y = [], []
    for i in range(n):
        match = rng.random() < 0.3
        dob = f"19{50 + i % 40}-0{1 + i % 9}-1{i % 9}"
        a = {
            "kind": "person",
            "name": f"Name{i} Surname{i % 50}",
            "birth_date": dob,
            "address": {"line1": f"{i} High St", "postcode": f"{2000 + i}"},
        }
        if match:
            b = {**a, "name": a["name"].replace("Name", "Nme")}
        else:
            j = int(rng.integers(0, n))
            b = {
                "kind": "person",
                "name": f"Name{j} Surname{i % 50}",
                "birth_date": f"19{50 + j % 40}-0{1 + j % 9}-2{j % 9}",
                "address": {"line1": f"{j} Low Rd", "postcode": f"{3000 + j}"},
            }
        rows.append(compare(a, b))
        y.append(int(match))
    return rows, np.array(y)


def test_em_learns_that_agreement_means_match():
    rows, y = _synthetic_pairs()
    fs = FellegiSunter().fit(rows)
    p = fs.probabilities(rows)
    assert p[y == 1].mean() > 0.8 and p[y == 0].mean() < 0.2
    assert fs.weights({**rows[int(np.argmax(y))]})["dob"] > 0


def test_fs_roundtrip_and_missing_fields_add_no_weight(tmp_path):
    rows, _ = _synthetic_pairs(200)
    fs = FellegiSunter().fit(rows)
    fs.save(tmp_path / "fs.json")
    fs2 = FellegiSunter.load(tmp_path / "fs.json")
    assert fs2.weight(rows[0]) == fs.weight(rows[0])
    empty = dict.fromkeys(rows[0], -1.0)
    empty["kind_agree"] = 1.0
    assert fs.weight(empty) == 0.0
    assert all(v is None for v in levels(empty).values())
