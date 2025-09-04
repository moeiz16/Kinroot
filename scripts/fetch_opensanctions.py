"""Download a small, screening-relevant OpenSanctions subset into data/opensanctions/ (git-ignored).

OpenSanctions data is licensed CC BY-NC 4.0: free for non-commercial use (this portfolio demo) with
attribution; commercial use needs a licence from OpenSanctions. Nothing downloaded here is ever committed.

Default subset (~40 MB, FollowTheMoney JSON lines):
  sanctions  au_dfat_sanctions (Australian Consolidated List), gb_fcdo_sanctions (UK sanctions list),
             un_sc_sanctions (UN Security Council)
  peps       au_parliament, au_nsw_parliament, gb_commons, gb_lords

Usage:
  backend/.venv/bin/python scripts/fetch_opensanctions.py [--datasets a,b,c] [--format ftm|csv] [--max-mb 150]
Writes data/opensanctions/<dataset>/{index.json, entities.ftm.json | targets.simple.csv} and
data/opensanctions/manifest.json ({dataset: {version, kind, file, sha1, entities}}), which the screening
loader reads when SANCTIONS_SOURCE=opensanctions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import socket
import sys
import urllib.request
from pathlib import Path


def _prefer_ipv4() -> None:
    """Some networks advertise IPv6 routes that silently drop traffic; urllib then hangs. Try IPv4 first."""
    original = socket.getaddrinfo

    def ordered(*args, **kwargs):
        return sorted(original(*args, **kwargs), key=lambda info: info[0] != socket.AF_INET)

    socket.getaddrinfo = ordered  # type: ignore[assignment]


_prefer_ipv4()


BASE = "https://data.opensanctions.org/datasets/latest/{name}/index.json"
USER_AGENT = "kinroot-data-fetch/0.1 (non-commercial demo)"
SANCTIONS = ["au_dfat_sanctions", "gb_fcdo_sanctions", "un_sc_sanctions"]
PEPS = ["au_parliament", "au_nsw_parliament", "gb_commons", "gb_lords"]
RESOURCE = {"ftm": "entities.ftm.json", "csv": "targets.simple.csv"}
ROOT = Path(__file__).resolve().parent.parent / "data" / "opensanctions"


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310 - fixed https host
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
        return resp.read()


def _download(url: str, dest: Path, expected_sha1: str | None) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310
    sha1 = hashlib.sha1()  # noqa: S324 - integrity check against the publisher's checksum, not security
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=120) as resp, tmp.open("wb") as out:  # noqa: S310
        while chunk := resp.read(1 << 20):
            sha1.update(chunk)
            out.write(chunk)
    digest = sha1.hexdigest()
    if expected_sha1 and digest != expected_sha1:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"checksum mismatch for {url}")
    tmp.replace(dest)
    return digest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", default=",".join(SANCTIONS + PEPS))
    ap.add_argument("--format", choices=sorted(RESOURCE), default="ftm")
    ap.add_argument(
        "--max-mb",
        type=float,
        default=150.0,
        help="refuse to download more than this in total",
    )
    args = ap.parse_args()

    names = [n.strip() for n in args.datasets.split(",") if n.strip()]
    plan = []
    for name in names:
        index = json.loads(_get(BASE.format(name=name)))
        res = next(
            (r for r in index.get("resources", []) if r["name"] == RESOURCE[args.format]),
            None,
        )
        if res is None:
            print(f"skip {name}: no {RESOURCE[args.format]}", file=sys.stderr)
            continue
        plan.append((name, index, res))
    total_mb = sum(r.get("size", 0) for _, _, r in plan) / 1e6
    print(f"{len(plan)} datasets, {total_mb:.1f} MB")
    if total_mb > args.max_mb:
        raise SystemExit(f"refusing: {total_mb:.1f} MB exceeds --max-mb {args.max_mb}")

    manifest_path = ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for name, index, res in plan:
        folder = ROOT / name
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "index.json").write_text(json.dumps(index, indent=1))
        dest = folder / res["name"]
        if manifest.get(name, {}).get("version") == index.get("version") and dest.exists():
            print(f"  {name}: up to date ({index.get('version')})")
            continue
        digest = _download(res["url"], dest, res.get("checksum"))
        tags = index.get("tags") or []
        manifest[name] = {
            "version": index.get("version"),
            "kind": "pep" if "list.pep" in tags or name in PEPS else "sanctions",
            "title": index.get("title"),
            "file": f"{name}/{res['name']}",
            "format": args.format,
            "sha1": digest,
            "entities": index.get("entity_count") or index.get("target_count"),
            "licence": "CC BY-NC 4.0 (OpenSanctions)",
        }
        print(f"  {name}: {res.get('size', 0) / 1e6:.1f} MB, version {index.get('version')}")
    manifest_path.write_text(json.dumps(manifest, indent=1, sort_keys=True))
    print(f"manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
