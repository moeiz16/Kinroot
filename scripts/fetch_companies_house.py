"""Download one part of the free Companies House PSC snapshot and extract small samples into
data/companies_house/ (git-ignored). No API key needed.

Source: https://download.companieshouse.gov.uk/en_pscdata.html: the full "people with significant control"
register as JSON lines, refreshed daily, offered as one file or split into ~80 MB parts. Companies House data is
Crown copyright and reusable under the Open Government Licence v3.0; it is public register data about real
people, so samples stay local, are never committed, and are used only for graph ingestion tests and for
building perturbed record pairs for entity-resolution training.

Outputs:
  psc_structures.jsonl   up to --companies companies whose PSCs include a corporate entity (ownership chains),
                         all PSC statements for those companies, grouped: {companyNumber, pscs: [...]}
  psc_individuals.jsonl  up to --individuals individual PSC records (name, partial birth date, nationality,
                         country of residence, locality/postcode) for ER pair generation
  manifest.json          source file name, part, counts, sha256 of outputs

Usage:
  backend/.venv/bin/python scripts/fetch_companies_house.py [--part 1] [--companies 300] [--individuals 20000]
                                                            [--keep-zip]
The raw zip (~80 MB) is deleted after extraction unless --keep-zip.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import socket
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path


def _prefer_ipv4() -> None:
    """Some networks advertise IPv6 routes that silently drop traffic; urllib then hangs. Try IPv4 first."""
    original = socket.getaddrinfo

    def ordered(*args, **kwargs):
        return sorted(original(*args, **kwargs), key=lambda info: info[0] != socket.AF_INET)

    socket.getaddrinfo = ordered  # type: ignore[assignment]


_prefer_ipv4()


INDEX = "https://download.companieshouse.gov.uk/en_pscdata.html"
BASE = "https://download.companieshouse.gov.uk/"
USER_AGENT = "kinroot-data-fetch/0.1"
ROOT = Path(__file__).resolve().parent.parent / "data" / "companies_house"
CORPORATE = "corporate-entity-person-with-significant-control"
INDIVIDUAL = "individual-person-with-significant-control"


def _open(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310 - fixed https host
    return urllib.request.urlopen(req, timeout=120)  # noqa: S310


def find_part(part: int) -> str:
    html = _open(INDEX).read().decode("utf-8", "replace")
    names = sorted(set(re.findall(r"psc-snapshot-\d{4}-\d{2}-\d{2}_(\d+)of(\d+)\.zip", html)))
    files = re.findall(r"(psc-snapshot-\d{4}-\d{2}-\d{2}_\d+of\d+\.zip)", html)
    wanted = [f for f in dict.fromkeys(files) if re.search(rf"_{part}of\d+\.zip$", f)]
    if not wanted:
        raise SystemExit(f"part {part} not listed on {INDEX} (found {len(names)} parts)")
    return wanted[0]


def download(name: str, dest: Path) -> None:
    tmp = dest.with_suffix(".part")
    with _open(BASE + name) as resp, tmp.open("wb") as out:
        while chunk := resp.read(1 << 20):
            out.write(chunk)
    tmp.replace(dest)


def _slim_individual(rec: dict) -> dict:
    data = rec.get("data", {})
    addr = data.get("address") or {}
    return {
        "companyNumber": rec.get("company_number"),
        "name": data.get("name"),
        "nameElements": data.get("name_elements"),
        "birthMonth": (data.get("date_of_birth") or {}).get("month"),
        "birthYear": (data.get("date_of_birth") or {}).get("year"),
        "nationality": data.get("nationality"),
        "countryOfResidence": data.get("country_of_residence"),
        "locality": addr.get("locality"),
        "postalCode": addr.get("postal_code"),
        "notifiedOn": data.get("notified_on"),
        "ceasedOn": data.get("ceased_on"),
        "naturesOfControl": data.get("natures_of_control"),
    }


def extract(zip_path: Path, max_companies: int, max_individuals: int) -> dict:
    by_company: dict[str, list[dict]] = defaultdict(list)
    corporate_companies: list[str] = []
    individuals: list[dict] = []
    with zipfile.ZipFile(zip_path) as zf:
        member = zf.namelist()[0]
        with zf.open(member) as raw:
            for line in io.TextIOWrapper(raw, encoding="utf-8"):
                rec = json.loads(line)
                number = rec.get("company_number")
                kind = (rec.get("data") or {}).get("kind")
                if not number or not kind:
                    continue  # trailer / summary lines
                if len(corporate_companies) < max_companies or number in by_company:
                    by_company[number].append(rec)
                    if kind == CORPORATE and number not in corporate_companies:
                        corporate_companies.append(number)
                if kind == INDIVIDUAL and len(individuals) < max_individuals:
                    individuals.append(_slim_individual(rec))
                # keep memory bounded: drop companies that turned out to have no corporate PSC
                if len(by_company) > max_companies * 20:
                    keep = set(corporate_companies)
                    by_company = defaultdict(list, {k: v for k, v in by_company.items() if k in keep})
    structures = [{"companyNumber": n, "pscs": by_company[n]} for n in corporate_companies[:max_companies]]
    return {"structures": structures, "individuals": individuals}


def _write_jsonl(path: Path, rows: list[dict]) -> str:
    body = "".join(json.dumps(r, separators=(",", ":"), sort_keys=True) + "\n" for r in rows)
    path.write_text(body, encoding="utf-8")
    return hashlib.sha256(body.encode()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--part", type=int, default=1)
    ap.add_argument("--companies", type=int, default=300)
    ap.add_argument("--individuals", type=int, default=20000)
    ap.add_argument("--keep-zip", action="store_true")
    args = ap.parse_args()

    (ROOT / "raw").mkdir(parents=True, exist_ok=True)
    name = find_part(args.part)
    zip_path = ROOT / "raw" / name
    if not zip_path.exists():
        print(f"downloading {name} …")
        download(name, zip_path)
    print(f"extracting from {zip_path.name} ({zip_path.stat().st_size / 1e6:.0f} MB)")
    out = extract(zip_path, args.companies, args.individuals)
    manifest = {
        "source": INDEX,
        "file": name,
        "licence": "Open Government Licence v3.0 (Companies House)",
        "structures": len(out["structures"]),
        "individuals": len(out["individuals"]),
        "sha256": {
            "psc_structures.jsonl": _write_jsonl(ROOT / "psc_structures.jsonl", out["structures"]),
            "psc_individuals.jsonl": _write_jsonl(ROOT / "psc_individuals.jsonl", out["individuals"]),
        },
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    if not args.keep_zip:
        zip_path.unlink()
    print(json.dumps({k: manifest[k] for k in ("file", "structures", "individuals")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
