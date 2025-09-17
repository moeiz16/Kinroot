"""Sample data for the demo firms (contract Part 5). Everything here is fictional.

Dates are offsets in days from the day the seed runs (negative = in the past), never calendar dates, except the
birth dates of fictional people. Party keys are local to one firm; edges point owner -> owned and
controller -> entity (graph conventions agreed with the domain core).
"""

from __future__ import annotations

from typing import Any

PASSWORD = "Kinroot-demo-2025!"

HARBOURLINE = {
    "name": "Harbourline Legal",
    "slug": "harbourline-legal",
    "country": "AU",
    "sector": "legal",
    "abn": "51 824 753 556",
    "address": "Level 14, 60 Martin Place, Sydney NSW 2000",
}
NORTHGATE = {
    "name": "Northgate Accountants",
    "slug": "northgate-accountants",
    "country": "GB",
    "sector": "accounting",
    "abn": "",
    "address": "3 Northgate Yard, London EC1V 9LT",
}

HARBOURLINE_MEMBERS = [
    ("olivia", "Olivia Grant", "olivia@harbourline.example", "owner", "#2F6B5E"),
    ("daniel", "Daniel Cho", "daniel@harbourline.example", "compliance_officer", "#8A5A2B"),
    ("margaret", "Margaret Ellis", "margaret@harbourline.example", "partner", "#4B5A8C"),
    ("tom", "Tom Nguyen", "tom@harbourline.example", "fee_earner", "#7A3E5C"),
    ("aisha", "Aisha Karim", "aisha@harbourline.example", "fee_earner", "#3F6E8C"),
    ("ruth", "Ruth Adeyemi", "ruth@harbourline.example", "auditor", "#6B6B2F"),
]
NORTHGATE_MEMBERS = [("priya", "Priya Shah", "priya@northgate.example", "compliance_officer", "#9C4A3A")]

# (member key, course, completed days ago); due one year after completion
TRAINING = [
    ("olivia", "AML/CTF program awareness", 120),
    ("daniel", "AML/CTF compliance officer annual refresher", 60),
    ("margaret", "Senior manager approvals and PEPs", 200),
    ("tom", "Customer due diligence for legal practitioners", 90),
    ("aisha", "Customer due diligence for conveyancers", 385),  # overdue by about 20 days
    ("ruth", "Independent review of AML/CTF programs", 340),  # due soon
]

SYD = {"line1": "Level 2, 15 Castlereagh St", "locality": "Sydney", "state": "NSW", "postcode": "2000", "country": "AU"}
MAHE = {"line1": "Suite 4, 88 Victoria St", "locality": "Victoria, Mahé", "country": "SC"}


def addr(line1: str, locality: str, state: str, postcode: str, country: str = "AU") -> dict[str, str]:
    return {"line1": line1, "locality": locality, "state": state, "postcode": postcode, "country": country}


# key: (kind, name, extra fields)
PARTIES: dict[str, tuple[str, str, dict[str, Any]]] = {
    # 1-3 trust over company over offshore holding
    "harbour_quay": (
        "company",
        "Harbour Quay Developments Pty Ltd",
        {
            "jurisdiction": "AU",
            "identifiers": {"acn": "612 345 670", "abn": "37 612 345 670"},
            "address": addr("8 Barangaroo Ave", "Barangaroo", "NSW", "2000"),
        },
    ),
    "kestrel_ventures": (
        "company",
        "Kestrel Ventures Ltd",
        {
            "jurisdiction": "VG",
            "address": {"line1": "Craigmuir Chambers", "locality": "Road Town, Tortola", "country": "VG"},
        },
    ),
    "bellmere": (
        "company",
        "Bellmere Holdings Pty Ltd",
        {
            "jurisdiction": "AU",
            "identifiers": {"acn": "609 112 584", "abn": "84 609 112 584"},
            "address": addr("Level 9, 1 O'Connell St", "Sydney", "NSW", "2000"),
        },
    ),
    "calder_trust": ("trust", "Calder Family Trust", {"jurisdiction": "AU"}),
    "calder_trustee": (
        "company",
        "Calder Trustee Co Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "605 774 213"}},
    ),
    "ava_calder": (
        "person",
        "Ava Calder",
        {
            "birth_date": "1971-04-12",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("22 Wolseley Rd", "Point Piper", "NSW", "2027"),
        },
    ),
    "ben_okafor": (
        "person",
        "Ben Okafor",
        {
            "birth_date": "1980-07-21",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("5 Ocean St", "Bondi", "NSW", "2026"),
        },
    ),
    "halyard": ("company", "Halyard Investments Ltd", {"jurisdiction": "VG"}),
    "ingrid_solberg": (
        "person",
        "Ingrid Solberg",
        {"birth_date": "1968-02-03", "nationality": "NO", "jurisdiction": "NO"},
    ),
    "victor_anand": (
        "person",
        "Victor Anand",
        {
            "birth_date": "1975-09-30",
            "nationality": "GB",
            "jurisdiction": "VG",
            "is_nominee": True,
            "address": {"line1": "Craigmuir Chambers", "locality": "Road Town, Tortola", "country": "VG"},
        },
    ),
    # 4-5 circular ownership
    "tasman_ridge": ("company", "Tasman Ridge Pty Ltd", {"jurisdiction": "AU", "identifiers": {"acn": "618 220 931"}}),
    "orchard_lane": (
        "company",
        "Orchard Lane Investments Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "621 450 117"}},
    ),
    "westerly": ("company", "Westerly Capital Ltd", {"jurisdiction": "NZ"}),
    "marcus_hale": (
        "person",
        "Marcus Hale",
        {
            "birth_date": "1966-11-08",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("14 Kent St", "Millers Point", "NSW", "2000"),
        },
    ),
    "marcus_hale_dup": ("person", "Marcus J. Hale", {"nationality": "AU", "jurisdiction": "AU", "source": "import"}),
    "fiona_byrne": ("person", "Fiona Byrne", {"birth_date": "1979-05-19", "nationality": "AU", "jurisdiction": "AU"}),
    "rangi_parata": ("person", "Rangi Parata", {"birth_date": "1972-01-25", "nationality": "NZ", "jurisdiction": "NZ"}),
    # 6-8 nominee-director cluster
    "lumen": (
        "company",
        "Lumen Trade Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "633 908 412"}, "address": SYD},
    ),
    "silverbirch": (
        "company",
        "Silverbirch Imports Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "634 117 205"}, "address": SYD},
    ),
    "coralline": (
        "company",
        "Coralline Logistics Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "635 442 819"}, "address": SYD},
    ),
    "gregory_pell": (
        "person",
        "Gregory Pell",
        {"birth_date": "1958-03-14", "nationality": "SC", "jurisdiction": "SC", "is_nominee": True, "address": MAHE},
    ),
    "gregory_pell_dup": (
        "person",
        "Gregory J Pell",
        {
            "birth_date": "1958-03-14",
            "nationality": "SC",
            "jurisdiction": "SC",
            "is_nominee": True,
            "address": MAHE,
            "source": "import",
        },
    ),
    "tobias_wren": ("person", "Tobias Wren", {"birth_date": "1983-06-02", "nationality": "AU", "jurisdiction": "AU"}),
    "nadia_brook": ("person", "Nadia Brook", {"birth_date": "1987-10-11", "nationality": "AU", "jurisdiction": "AU"}),
    "owen_pryce": ("person", "Owen Pryce", {"birth_date": "1974-12-29", "nationality": "AU", "jurisdiction": "AU"}),
    "lena_fischer": ("person", "Lena Fischer", {"birth_date": "1985-08-08", "nationality": "DE", "jurisdiction": "AU"}),
    "hugh_tran": (
        "person",
        "Hugh Tran",
        {
            "birth_date": "1970-04-04",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("Suite 9, 120 Pitt St", "Sydney", "NSW", "2000"),
        },
    ),
    # 9 sanctions near-match (likely true)
    "aurelian_shipping": (
        "company",
        "Aurelian Shipping Pty Ltd",
        {
            "jurisdiction": "AU",
            "identifiers": {"acn": "640 318 556"},
            "address": addr("Berth 7, Port Botany", "Port Botany", "NSW", "2036"),
        },
    ),
    "aurelian_fze": (
        "company",
        "Aurelian Maritime FZE",
        {
            "jurisdiction": "AE",
            "address": {"line1": "Jebel Ali Free Zone, LOB 15", "locality": "Dubai", "country": "AE"},
        },
    ),
    "karim_haddad": (
        "person",
        "Karim Haddad",
        {
            "birth_date": "1969-07-07",
            "nationality": "LB",
            "jurisdiction": "AE",
            "address": {"locality": "Dubai", "country": "AE"},
        },
    ),
    "peter_lowe": ("person", "Peter Lowe", {"birth_date": "1977-03-21", "nationality": "AU", "jurisdiction": "AU"}),
    # 10-12 individuals, PEP
    "alexei_petrov": (
        "person",
        "Alexei Petrov",
        {
            "birth_date": "1984-05-17",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("31 Glebe Point Rd", "Glebe", "NSW", "2037"),
        },
    ),
    "julian_whitfield": (
        "person",
        "Hon. Julian Whitfield",
        {
            "birth_date": "1961-08-03",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("4 Fairfax Rd", "Bellevue Hill", "NSW", "2023"),
        },
    ),
    "claire_whitfield": (
        "person",
        "Claire Whitfield",
        {"birth_date": "1964-12-15", "nationality": "AU", "jurisdiction": "AU"},
    ),
    "clare_whitfield_dup": (
        "person",
        "Clare Whitfield",
        {"nationality": "AU", "jurisdiction": "AU", "source": "import"},
    ),
    "whitfield_fund": ("trust", "Whitfield Family Super Fund", {"jurisdiction": "AU"}),
    "whitfield_super": (
        "company",
        "Whitfield Super Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "611 004 382"}},
    ),
    # 13 partnership
    "ferris_wu": (
        "partnership",
        "Ferris & Wu Partners",
        {"jurisdiction": "AU", "identifiers": {"abn": "62 118 440 935"}},
    ),
    "alan_ferris": ("person", "Alan Ferris", {"birth_date": "1969-02-14", "nationality": "AU", "jurisdiction": "AU"}),
    "grace_wu": ("person", "Grace Wu", {"birth_date": "1973-09-01", "nationality": "AU", "jurisdiction": "AU"}),
    "imran_siddiqui": (
        "person",
        "Imran Siddiqui",
        {"birth_date": "1982-06-12", "nationality": "AU", "jurisdiction": "AU"},
    ),
    "imran_siddiqi_dup": (
        "person",
        "Imran Siddiqi",
        {"birth_date": "1982-06-01", "nationality": "AU", "jurisdiction": "AU", "source": "import"},
    ),
    # 14-17
    "brightwater": (
        "company",
        "Brightwater Realty Pty Ltd",
        {
            "jurisdiction": "AU",
            "identifiers": {"acn": "602 993 170"},
            "address": addr("88 The Corso", "Manly", "NSW", "2095"),
        },
    ),
    "sophie_lander": (
        "person",
        "Sophie Lander",
        {"birth_date": "1981-01-30", "nationality": "AU", "jurisdiction": "AU"},
    ),
    "linh_nguyen": (
        "person",
        "Linh Nguyen",
        {
            "birth_date": "1990-10-05",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("7 Railway Pde", "Burwood", "NSW", "2134"),
        },
    ),
    "sean_oconnor": (
        "person",
        "Sean O'Connor",
        {
            "birth_date": "1979-02-11",
            "nationality": "IE",
            "jurisdiction": "AU",
            "address": addr("12 Hale Rd", "Mosman", "NSW", "2088"),
        },
    ),
    "sean_oconnor_dup": (
        "person",
        "Sean OConnor",
        {
            "birth_date": "1979-02-11",
            "nationality": "IE",
            "jurisdiction": "AU",
            "address": addr("12 Hale Road", "Mosman", "NSW", "2088"),
            "source": "import",
        },
    ),
    "riya_patel": (
        "person",
        "Riya Patel",
        {
            "birth_date": "1988-04-22",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("40 Church St", "Parramatta", "NSW", "2150"),
        },
    ),
    # 18 three-layer group, officer change
    "harrow_mining": (
        "company",
        "Harrow Mining Services Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "607 551 248"}},
    ),
    "harrow_group": (
        "company",
        "Harrow Group Holdings Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "607 551 001"}},
    ),
    "harrow_resources": (
        "company",
        "Harrow Resources Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "600 120 774"}},
    ),
    "dale_harrow": ("person", "Dale Harrow", {"birth_date": "1962-07-19", "nationality": "AU", "jurisdiction": "AU"}),
    "ming_zhou": ("person", "Ming Zhou", {"birth_date": "1976-03-03", "nationality": "AU", "jurisdiction": "AU"}),
    "phil_burke": ("person", "Phil Burke", {"birth_date": "1959-05-05", "nationality": "AU", "jurisdiction": "AU"}),
    "anika_rao": ("person", "Anika Rao", {"birth_date": "1984-11-27", "nationality": "AU", "jurisdiction": "AU"}),
    # 19 UK parent with PSC chain
    "kestrel_uk": (
        "company",
        "Kestrel Holdings (UK) Ltd",
        {
            "jurisdiction": "GB",
            "identifiers": {"ukCompanyNumber": "12847719"},
            "address": {"line1": "71 Fenchurch St", "locality": "London", "postcode": "EC3M 4BS", "country": "GB"},
        },
    ),
    "kestrel_group": (
        "company",
        "Kestrel Group Ltd",
        {"jurisdiction": "GB", "identifiers": {"ukCompanyNumber": "11402266"}},
    ),
    # 20 company limited by guarantee
    "blue_gum": ("company", "Blue Gum Childcare Ltd", {"jurisdiction": "AU", "identifiers": {"acn": "615 330 902"}}),
    "helen_moss": ("person", "Helen Moss", {"birth_date": "1970-08-16", "nationality": "AU", "jurisdiction": "AU"}),
    "peter_quinn": ("person", "Peter Quinn", {"birth_date": "1958-12-01", "nationality": "AU", "jurisdiction": "AU"}),
    "joy_lam": ("person", "Joy Lam", {"birth_date": "1980-02-29", "nationality": "AU", "jurisdiction": "AU"}),
    # 21-24
    "marlowe": (
        "company",
        "Marlowe Fine Art Pty Ltd",
        {
            "jurisdiction": "AU",
            "identifiers": {"acn": "619 772 045"},
            "address": addr("3 Queen St", "Woollahra", "NSW", "2025"),
        },
    ),
    "edmund_marlowe": (
        "person",
        "Edmund Marlowe",
        {"birth_date": "1955-06-18", "nationality": "GB", "jurisdiction": "AU"},
    ),
    "kenji_sato": (
        "person",
        "Kenji Sato",
        {
            "birth_date": "1978-09-09",
            "nationality": "JP",
            "jurisdiction": "JP",
            "address": {"line1": "2-11-3 Meguro", "locality": "Tokyo", "postcode": "153-0063", "country": "JP"},
        },
    ),
    "delacroix_trust": ("trust", "Delacroix Unit Trust", {"jurisdiction": "AU"}),
    "delacroix_nominees": (
        "company",
        "Delacroix Nominees Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "626 118 990"}},
    ),
    "amelie_delacroix": (
        "person",
        "Amélie Delacroix",
        {"birth_date": "1983-03-11", "nationality": "FR", "jurisdiction": "AU"},
    ),
    "louis_delacroix": (
        "person",
        "Louis Delacroix",
        {"birth_date": "1985-07-02", "nationality": "FR", "jurisdiction": "AU"},
    ),
    "celine_delacroix": (
        "person",
        "Céline Delacroix",
        {"birth_date": "1988-12-24", "nationality": "FR", "jurisdiction": "AU"},
    ),
    "northshore": (
        "company",
        "Northshore Dental Group Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "613 207 556"}},
    ),
    "priya_nair": ("person", "Dr Priya Nair", {"birth_date": "1979-01-15", "nationality": "AU", "jurisdiction": "AU"}),
    "owen_hughes": (
        "person",
        "Dr Owen Hughes",
        {"birth_date": "1976-05-28", "nationality": "AU", "jurisdiction": "AU"},
    ),
    "linh_nguyen_other": (
        "person",
        "Linh Nguyen",
        {
            "birth_date": "1972-02-08",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("19 Pacific Hwy", "Chatswood", "NSW", "2067"),
        },
    ),
    # 25 ownership change via Cayman entity
    "ironbark": ("company", "Ironbark Ventures Pty Ltd", {"jurisdiction": "AU", "identifiers": {"acn": "622 845 310"}}),
    "callum_reid": ("person", "Callum Reid", {"birth_date": "1981-10-10", "nationality": "AU", "jurisdiction": "AU"}),
    "cayman_ridge": (
        "company",
        "Cayman Ridge Holdings Ltd",
        {"jurisdiction": "KY", "address": {"line1": "94 Solaris Ave", "locality": "Camana Bay", "country": "KY"}},
    ),
    "anton_vela": ("person", "Anton Vela", {"birth_date": "1973-04-17", "nationality": "ES", "jurisdiction": "KY"}),
    # 26-28
    "greenfield": (
        "company",
        "Greenfield Estates Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "624 501 776"}},
    ),
    "benjamin_okafor": (
        "person",
        "Benjamin Okafor",
        {
            "birth_date": "1980-07-21",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("18 Collins St", "Melbourne", "VIC", "3000"),
        },
    ),
    "lucy_okafor": ("person", "Lucy Okafor", {"birth_date": "1982-09-14", "nationality": "AU", "jurisdiction": "AU"}),
    "murray_chen": (
        "person",
        "Murray Chen",
        {
            "birth_date": "1975-03-02",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("6 Hunter St", "Hornsby", "NSW", "2077"),
        },
    ),
    "murray_cheng": ("person", "Murray Cheng", {"birth_date": "1981-11-19", "nationality": "AU", "jurisdiction": "AU"}),
    "southbank": (
        "company",
        "Southbank Holdings Pty Ltd",
        {"jurisdiction": "AU", "identifiers": {"acn": "628 330 114"}},
    ),
    "gareth_lloyd": ("person", "Gareth Lloyd", {"birth_date": "1967-06-06", "nationality": "GB", "jurisdiction": "AU"}),
    "bearer_holder": ("other", "Undisclosed bearer shareholder", {}),
    # 29 trust onboarding incomplete
    "lim_trust": ("trust", "Lim Family Trust", {"jurisdiction": "AU"}),
    "wei_lim": (
        "person",
        "Wei Lim",
        {
            "birth_date": "1965-02-18",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("2 Lane Cove Rd", "Ryde", "NSW", "2112"),
        },
    ),
    "mei_lim": (
        "person",
        "Mei Lim",
        {
            "birth_date": "1968-11-03",
            "nationality": "AU",
            "jurisdiction": "AU",
            "address": addr("2 Lane Cove Rd", "Ryde", "NSW", "2112"),
        },
    ),
    "jun_lim": ("person", "Jun Lim", {"birth_date": "1996-07-21", "nationality": "AU", "jurisdiction": "AU"}),
    # 30 exited partnership
    "coastal": (
        "partnership",
        "Coastal Conveyancing Co",
        {"jurisdiction": "AU", "identifiers": {"abn": "29 604 118 773"}},
    ),
    "ross_keane": ("person", "Ross Keane", {"birth_date": "1960-10-12", "nationality": "AU", "jurisdiction": "AU"}),
    "tara_keane": ("person", "Tara Keane", {"birth_date": "1963-01-07", "nationality": "AU", "jurisdiction": "AU"}),
}

# (from, to, pct, interest, since_days)  -- ownership
OWNERSHIP: list[tuple[str, str, float, str, int, int | None]] = [
    ("kestrel_ventures", "harbour_quay", 100, "shares", -2400, None),
    ("bellmere", "kestrel_ventures", 80, "shares", -2100, None),
    ("halyard", "kestrel_ventures", 20, "shares", -2100, None),
    ("ingrid_solberg", "halyard", 100, "shares", -2500, None),
    ("calder_trust", "bellmere", 62, "shares", -2600, None),
    ("ben_okafor", "bellmere", 38, "shares", -2600, None),
    ("ava_calder", "calder_trust", 100, "trust_entitlement", -3000, None),
    ("ava_calder", "calder_trustee", 100, "shares", -3000, None),
    # circular
    ("marcus_hale", "tasman_ridge", 50, "shares", -1500, None),
    ("westerly", "tasman_ridge", 50, "shares", -1200, None),
    ("tasman_ridge", "orchard_lane", 60, "shares", -1400, None),
    ("fiona_byrne", "orchard_lane", 40, "shares", -1400, None),
    ("orchard_lane", "westerly", 70, "shares", -1300, None),
    ("rangi_parata", "westerly", 30, "shares", -1300, None),
    # nominee cluster
    ("tobias_wren", "lumen", 100, "shares", -900, None),
    ("nadia_brook", "silverbirch", 100, "shares", -850, None),
    ("owen_pryce", "coralline", 60, "shares", -800, None),
    ("lena_fischer", "coralline", 40, "shares", -800, None),
    # sanctions near-match
    ("aurelian_fze", "aurelian_shipping", 100, "shares", -700, None),
    ("karim_haddad", "aurelian_fze", 100, "shares", -1800, None),
    # PEP super fund
    ("julian_whitfield", "whitfield_fund", 60, "trust_entitlement", -4000, None),
    ("claire_whitfield", "whitfield_fund", 40, "trust_entitlement", -4000, None),
    # partnership
    ("alan_ferris", "ferris_wu", 40, "partnership", -3500, None),
    ("grace_wu", "ferris_wu", 40, "partnership", -3500, None),
    ("imran_siddiqui", "ferris_wu", 20, "partnership", -1100, None),
    ("sophie_lander", "brightwater", 60, "shares", -2000, None),
    ("sean_oconnor_dup", "brightwater", 40, "shares", -600, None),
    # three-layer group
    ("harrow_group", "harrow_mining", 100, "shares", -2800, None),
    ("harrow_resources", "harrow_group", 100, "shares", -2800, None),
    ("dale_harrow", "harrow_resources", 55, "shares", -3200, None),
    ("ming_zhou", "harrow_resources", 45, "shares", -3200, None),
    # UK PSC chain
    ("kestrel_group", "kestrel_uk", 100, "shares", -1600, None),
    ("ingrid_solberg", "kestrel_group", 75, "shares", -1700, None),
    ("ben_okafor", "kestrel_group", 25, "shares", -1700, None),
    # unit trust
    ("amelie_delacroix", "delacroix_trust", 34, "units", -1900, None),
    ("louis_delacroix", "delacroix_trust", 33, "units", -1900, None),
    ("celine_delacroix", "delacroix_trust", 33, "units", -1900, None),
    ("amelie_delacroix", "delacroix_nominees", 100, "shares", -1900, None),
    ("priya_nair", "northshore", 50, "shares", -1700, None),
    ("owen_hughes", "northshore", 50, "shares", -1700, None),
    # ownership change last month: Callum Reid held 100% until 30 days ago; now 60% + Cayman entity 40%
    ("callum_reid", "ironbark", 100, "shares", -1500, -31),
    ("callum_reid", "ironbark", 60, "shares", -30, None),
    ("cayman_ridge", "ironbark", 40, "shares", -30, None),
    ("anton_vela", "cayman_ridge", 100, "shares", -400, None),
    ("benjamin_okafor", "greenfield", 70, "shares", -1300, None),
    ("lucy_okafor", "greenfield", 30, "shares", -1300, None),
    ("gareth_lloyd", "southbank", 70, "shares", -1100, None),
    ("bearer_holder", "southbank", 30, "shares", -1100, None),
    ("wei_lim", "lim_trust", 50, "trust_entitlement", -900, None),
    ("mei_lim", "lim_trust", 25, "trust_entitlement", -900, None),
    ("jun_lim", "lim_trust", 25, "trust_entitlement", -900, None),
    ("edmund_marlowe", "marlowe", 100, "shares", -2200, None),
    ("ross_keane", "coastal", 50, "partnership", -4000, None),
    ("tara_keane", "coastal", 50, "partnership", -4000, None),
]

# (from, to, role, since_days, until_days, nominee)
CONTROL: list[tuple[str, str, str, int, int | None, bool]] = [
    ("ava_calder", "harbour_quay", "director", -2400, None, False),
    ("victor_anand", "kestrel_ventures", "director", -2100, None, True),
    ("calder_trustee", "calder_trust", "trustee", -3000, None, False),
    ("ava_calder", "calder_trust", "appointor", -3000, None, False),
    ("ava_calder", "calder_trustee", "director", -3000, None, False),
    ("ben_okafor", "bellmere", "director", -2600, None, False),
    ("marcus_hale", "tasman_ridge", "director", -1500, None, False),
    ("marcus_hale_dup", "orchard_lane", "director", -1400, None, False),
    ("gregory_pell", "lumen", "director", -900, None, True),
    ("gregory_pell_dup", "silverbirch", "director", -850, None, True),
    ("gregory_pell", "coralline", "director", -800, None, True),
    ("hugh_tran", "lumen", "secretary", -900, None, False),
    ("hugh_tran", "coralline", "secretary", -800, None, False),
    ("peter_lowe", "aurelian_shipping", "director", -700, None, False),
    ("karim_haddad", "aurelian_fze", "director", -1800, None, False),
    ("whitfield_super", "whitfield_fund", "trustee", -4000, None, False),
    ("julian_whitfield", "whitfield_super", "director", -4000, None, False),
    ("clare_whitfield_dup", "whitfield_super", "director", -4000, None, False),
    ("alan_ferris", "ferris_wu", "partner", -3500, None, False),
    ("grace_wu", "ferris_wu", "partner", -3500, None, False),
    ("imran_siddiqi_dup", "ferris_wu", "partner", -1100, None, False),
    ("sophie_lander", "brightwater", "director", -2000, None, False),
    ("phil_burke", "harrow_mining", "director", -2800, -30, False),
    ("anika_rao", "harrow_mining", "director", -29, None, False),
    ("dale_harrow", "harrow_resources", "director", -3200, None, False),
    ("victor_anand", "kestrel_uk", "director", -1600, None, False),
    ("ingrid_solberg", "kestrel_uk", "significant_control", -1600, None, False),
    ("helen_moss", "blue_gum", "senior_managing_official", -1200, None, False),
    ("peter_quinn", "blue_gum", "director", -2500, None, False),
    ("joy_lam", "blue_gum", "director", -1800, None, False),
    ("edmund_marlowe", "marlowe", "director", -2200, None, False),
    ("delacroix_nominees", "delacroix_trust", "trustee", -1900, None, False),
    ("amelie_delacroix", "delacroix_nominees", "director", -1900, None, False),
    ("priya_nair", "northshore", "director", -1700, None, False),
    ("linh_nguyen_other", "northshore", "secretary", -900, None, False),
    ("callum_reid", "ironbark", "director", -1500, None, False),
    ("murray_cheng", "greenfield", "director", -1300, None, False),
    ("gareth_lloyd", "southbank", "director", -1100, None, False),
    ("wei_lim", "lim_trust", "trustee", -900, None, False),
    ("ross_keane", "coastal", "partner", -4000, None, False),
    ("tara_keane", "coastal", "partner", -4000, None, False),
]

DORMANT_WORDS = [
    "Amberline",
    "Basalt",
    "Cedar Point",
    "Driftwood",
    "Eastgate",
    "Fairhaven",
    "Granite Bay",
    "Harbourview",
    "Ironside",
    "Juniper",
    "Kingfisher",
    "Lighthouse",
    "Marigold",
    "Northwind",
    "Oakridge",
    "Pinecrest",
    "Quayside",
    "Redstone",
    "Saltmarsh",
    "Tidewater",
    "Upland",
    "Valemont",
    "Westhaven",
    "Yarrow",
    "Zephyr",
    "Anchorage",
    "Bluewater",
    "Coral Reef",
    "Dunmore",
    "Evergreen",
    "Foxglove",
    "Greystone",
    "Heathfield",
    "Islington",
    "Jasper",
    "Kestwick",
    "Larkspur",
    "Meridian",
    "Netherby",
    "Orion",
    "Palisade",
]  # 41 dormant companies directed by the nominee

# key, client name, kind, party key, scenario fields
CLIENTS: list[dict[str, Any]] = [
    {
        "key": "harbour-quay",
        "party": "harbour_quay",
        "kind": "company",
        "rating": "high",
        "services": ["property_transaction", "managing_client_funds"],
        "channel": "intermediary",
        "assigned": "tom",
        "onboarded": -420,
        "review": 300,
        "matter": "HL-2291",
    },
    {
        "key": "bellmere",
        "party": "bellmere",
        "kind": "company",
        "rating": "medium",
        "services": ["company_formation"],
        "channel": "face_to_face",
        "assigned": "margaret",
        "onboarded": -900,
        "review": 190,
    },
    {
        "key": "calder-trust",
        "party": "calder_trust",
        "kind": "trust",
        "rating": "medium",
        "services": ["trust_formation", "tax_advice"],
        "channel": "face_to_face",
        "assigned": "margaret",
        "onboarded": -880,
        "review": 210,
    },
    {
        "key": "tasman-ridge",
        "party": "tasman_ridge",
        "kind": "company",
        "rating": "high",
        "services": ["property_transaction"],
        "channel": "intermediary",
        "assigned": "tom",
        "onboarded": -300,
        "review": 65,
    },
    {
        "key": "orchard-lane",
        "party": "orchard_lane",
        "kind": "company",
        "rating": "medium",
        "services": ["property_transaction"],
        "channel": "intermediary",
        "assigned": "tom",
        "onboarded": -290,
        "review": 440,
    },
    {
        "key": "lumen-trade",
        "party": "lumen",
        "kind": "company",
        "rating": "high",
        "services": ["company_formation", "managing_client_funds"],
        "channel": "remote",
        "assigned": "tom",
        "onboarded": -150,
        "review": 215,
    },
    {
        "key": "silverbirch",
        "party": "silverbirch",
        "kind": "company",
        "rating": "high",
        "services": ["company_formation"],
        "channel": "remote",
        "assigned": "aisha",
        "onboarded": -140,
        "review": 225,
    },
    {
        "key": "coralline",
        "party": "coralline",
        "kind": "company",
        "rating": "medium",
        "services": ["company_formation"],
        "channel": "remote",
        "assigned": "aisha",
        "onboarded": -130,
        "review": 600,
    },
    {
        "key": "aurelian-shipping",
        "party": "aurelian_shipping",
        "kind": "company",
        "rating": "high",
        "services": ["property_transaction", "managing_client_funds"],
        "channel": "remote",
        "assigned": "tom",
        "onboarded": -200,
        "review": 165,
    },
    {
        "key": "petrov-alexei",
        "party": "alexei_petrov",
        "kind": "individual",
        "rating": "low",
        "services": ["conveyancing"],
        "channel": "face_to_face",
        "assigned": "aisha",
        "onboarded": -100,
        "review": 990,
    },
    {
        "key": "whitfield-julian",
        "party": "julian_whitfield",
        "kind": "individual",
        "rating": "high",
        "services": ["property_transaction", "tax_advice"],
        "channel": "face_to_face",
        "assigned": "tom",
        "onboarded": None,
        "review": None,
        "submitted": -12,
    },
    {
        "key": "whitfield-family",
        "party": "whitfield_fund",
        "kind": "trust",
        "rating": "medium",
        "services": ["trust_formation", "tax_advice"],
        "channel": "face_to_face",
        "assigned": "margaret",
        "onboarded": -1500,
        "review": 120,
    },
    {
        "key": "ferris-wu",
        "party": "ferris_wu",
        "kind": "partnership",
        "rating": "low",
        "services": ["tax_advice", "audit"],
        "channel": "face_to_face",
        "assigned": "margaret",
        "onboarded": -1100,
        "review": -5,
    },
    {
        "key": "brightwater-re",
        "party": "brightwater",
        "kind": "company",
        "rating": "low",
        "services": ["real_estate_sale"],
        "channel": "face_to_face",
        "assigned": "aisha",
        "onboarded": -1080,
        "review": 20,
    },
    {
        "key": "nguyen-linh",
        "party": "linh_nguyen",
        "kind": "individual",
        "rating": "low",
        "services": ["conveyancing"],
        "channel": "remote",
        "assigned": "aisha",
        "onboarded": -60,
        "review": 1030,
        "electronic": True,
    },
    {
        "key": "oconnor-sean",
        "party": "sean_oconnor",
        "kind": "individual",
        "rating": "low",
        "services": ["conveyancing"],
        "channel": "face_to_face",
        "assigned": "aisha",
        "onboarded": -75,
        "review": 1015,
    },
    {
        "key": "patel-riya",
        "party": "riya_patel",
        "kind": "individual",
        "rating": "low",
        "services": ["property_transaction"],
        "channel": "face_to_face",
        "assigned": "aisha",
        "onboarded": -1135,
        "review": -40,
    },
    {
        "key": "harrow-mining",
        "party": "harrow_mining",
        "kind": "company",
        "rating": "medium",
        "services": ["managing_client_funds", "other"],
        "channel": "face_to_face",
        "assigned": "margaret",
        "onboarded": -500,
        "review": 230,
    },
    {
        "key": "kestrel-holdings-uk",
        "party": "kestrel_uk",
        "kind": "company",
        "rating": "medium",
        "services": ["company_formation"],
        "channel": "intermediary",
        "assigned": "tom",
        "onboarded": -350,
        "review": 380,
    },
    {
        "key": "blue-gum",
        "party": "blue_gum",
        "kind": "company",
        "rating": "low",
        "services": ["other"],
        "channel": "face_to_face",
        "assigned": "margaret",
        "onboarded": -700,
        "review": 395,
    },
    {
        "key": "marlowe-art",
        "party": "marlowe",
        "kind": "company",
        "rating": "medium",
        "services": ["managing_client_funds", "other"],
        "channel": "face_to_face",
        "assigned": "tom",
        "onboarded": -720,
        "review": 10,
    },
    {
        "key": "sato-kenji",
        "party": "kenji_sato",
        "kind": "individual",
        "rating": "medium",
        "services": ["property_transaction"],
        "channel": "remote",
        "assigned": "aisha",
        "onboarded": -705,
        "review": 25,
    },
    {
        "key": "delacroix-trust",
        "party": "delacroix_trust",
        "kind": "trust",
        "rating": "medium",
        "services": ["trust_formation"],
        "channel": "face_to_face",
        "assigned": "margaret",
        "onboarded": -702,
        "review": 28,
    },
    {
        "key": "northshore-dental",
        "party": "northshore",
        "kind": "company",
        "rating": "low",
        "services": ["property_transaction"],
        "channel": "face_to_face",
        "assigned": "tom",
        "onboarded": -1107,
        "review": -12,
    },
    {
        "key": "ironbark-ventures",
        "party": "ironbark",
        "kind": "company",
        "rating": "high",
        "services": ["company_formation", "managing_client_funds"],
        "channel": "remote",
        "assigned": "tom",
        "onboarded": -400,
        "review": 330,
    },
    {
        "key": "greenfield-estates",
        "party": "greenfield",
        "kind": "company",
        "rating": "medium",
        "services": ["property_transaction"],
        "channel": "face_to_face",
        "assigned": "aisha",
        "onboarded": -250,
        "review": 480,
    },
    {
        "key": "murray-chen",
        "party": "murray_chen",
        "kind": "individual",
        "rating": "low",
        "services": ["conveyancing"],
        "channel": "face_to_face",
        "assigned": "aisha",
        "onboarded": -90,
        "review": 1000,
    },
    {
        "key": "southbank-holdings",
        "party": "southbank",
        "kind": "company",
        "rating": "high",
        "services": ["property_transaction"],
        "channel": "intermediary",
        "assigned": "tom",
        "onboarded": -180,
        "review": 185,
    },
    {
        "key": "lim-family",
        "party": "lim_trust",
        "kind": "trust",
        "rating": None,
        "services": ["trust_formation"],
        "channel": "face_to_face",
        "assigned": "aisha",
        "onboarded": None,
        "review": None,
        "incomplete": "jun_lim",
    },
    {
        "key": "coastal-conveyancing",
        "party": "coastal",
        "kind": "partnership",
        "rating": "low",
        "services": ["conveyancing"],
        "channel": "face_to_face",
        "assigned": "margaret",
        "onboarded": -3000,
        "review": None,
        "ended": -730,
    },
]

# Northgate Accountants (UK). The company client is built from the Companies House sample when downloaded.
NORTHGATE_PARTIES: dict[str, tuple[str, str, dict[str, Any]]] = {
    "oliver_bennett": (
        "person",
        "Oliver Bennett",
        {
            "birth_date": "1984-03-09",
            "nationality": "GB",
            "jurisdiction": "GB",
            "address": {"line1": "17 Canonbury Sq", "locality": "London", "postcode": "N1 2AL", "country": "GB"},
        },
    ),
    "penrose": (
        "company",
        "Penrose Bakeries Ltd",
        {"jurisdiction": "GB", "identifiers": {"ukCompanyNumber": "10992834"}},
    ),
    "amelia_penrose": (
        "person",
        "Amelia Penrose",
        {"birth_date": "1977-07-14", "nationality": "GB", "jurisdiction": "GB"},
    ),
    "clarke_hale": (
        "partnership",
        "Clarke & Hale LLP",
        {"jurisdiction": "GB", "identifiers": {"ukCompanyNumber": "OC428871"}},
    ),
    "james_clarke": ("person", "James Clarke", {"birth_date": "1971-01-21", "nationality": "GB", "jurisdiction": "GB"}),
    "sarah_hale": ("person", "Sarah Hale", {"birth_date": "1974-10-30", "nationality": "GB", "jurisdiction": "GB"}),
}
NORTHGATE_OWNERSHIP = [
    ("amelia_penrose", "penrose", 100, "shares", -2000, None),
    ("james_clarke", "clarke_hale", 50, "partnership", -3000, None),
    ("sarah_hale", "clarke_hale", 50, "partnership", -3000, None),
]
NORTHGATE_CONTROL = [
    ("amelia_penrose", "penrose", "director", -2000, None, False),
    ("james_clarke", "clarke_hale", "partner", -3000, None, False),
    ("sarah_hale", "clarke_hale", "partner", -3000, None, False),
]
NORTHGATE_CLIENTS: list[dict[str, Any]] = [
    {
        "key": "bennett-oliver",
        "party": "oliver_bennett",
        "kind": "individual",
        "rating": "low",
        "services": ["tax_advice"],
        "channel": "face_to_face",
        "assigned": "priya",
        "onboarded": -500,
        "review": 600,
    },
    {
        "key": "penrose-bakeries",
        "party": "penrose",
        "kind": "company",
        "rating": "low",
        "services": ["audit", "tax_advice"],
        "channel": "face_to_face",
        "assigned": "priya",
        "onboarded": -800,
        "review": 300,
    },
    {
        "key": "clarke-hale",
        "party": "clarke_hale",
        "kind": "partnership",
        "rating": "low",
        "services": ["audit"],
        "channel": "face_to_face",
        "assigned": "priya",
        "onboarded": -1200,
        "review": 100,
    },
]

AURELIAN_CASE: dict[str, Any] = {
    "title": "Funds routed through a free-zone parent",
    "grounds": (
        "Aurelian Shipping's sole shareholder, Aurelian Maritime FZE (Dubai), closely matches a sanctioned "
        "entity on the sample list (same city, shared director surname). Settlement funds for the Port Botany "
        "lease were received from a third-party account in the UAE two days before the client asked to change "
        "the paying entity. The explanation given does not match the structure on file."
    ),
    "narrative": (
        "We act for Aurelian Shipping Pty Ltd on a commercial lease and the purchase of warehouse premises. "
        "Its 100% shareholder is Aurelian Maritime FZE, a Jebel Ali free-zone company whose director is "
        "Karim Haddad. Screening returned a strong near-match to a listed entity with the same trading name and "
        "city. Two deposits totalling AUD 1.85m arrived from an unrelated UAE account, and the client then asked "
        "that settlement be made by a different entity. We have not informed the client of this report."
    ),
    "transactions": [
        {"days": -9, "amount": "1100000.00", "currency": "AUD", "description": "Deposit from third-party UAE account"},
        {"days": -7, "amount": "750000.00", "currency": "AUD", "description": "Second deposit, same remitter"},
    ],
}
