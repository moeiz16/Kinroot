"""ABN Lookup (Australian Business Register) fetcher: live only when ABN_LOOKUP_GUID is set.

ABN Lookup web services are free but need a registered authentication GUID, so the product defaults to
ABN_SOURCE=mock: a deterministic adapter over the synthetic AU registry bundled with the backend
(companies with ACNs, trusts and partnerships with ABNs, all clearly fictional). This script exists so a
GUID holder can capture a few real responses into data/abn/ (git-ignored) to check the adapter's mapping.

Usage:
  ABN_LOOKUP_GUID=… backend/.venv/bin/python scripts/fetch_abn.py 53004085616 [more ABNs…]
"""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import urllib.parse
import urllib.request
from pathlib import Path


def _prefer_ipv4() -> None:
    """Some networks advertise IPv6 routes that silently drop traffic; urllib then hangs. Try IPv4 first."""
    original = socket.getaddrinfo

    def ordered(*args, **kwargs):
        return sorted(original(*args, **kwargs), key=lambda info: info[0] != socket.AF_INET)

    socket.getaddrinfo = ordered  # type: ignore[assignment]


_prefer_ipv4()


ENDPOINT = "https://abr.business.gov.au/json/AbnDetails.aspx"
ROOT = Path(__file__).resolve().parent.parent / "data" / "abn"


def fetch(abn: str, guid: str) -> dict:
    query = urllib.parse.urlencode({"abn": abn, "callback": "cb", "guid": guid})
    req = urllib.request.Request(f"{ENDPOINT}?{query}", headers={"User-Agent": "kinroot-data-fetch/0.1"})  # noqa: S310
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https host
        body = resp.read().decode("utf-8")
    match = re.fullmatch(r"\s*cb\((.*)\)\s*;?\s*", body, flags=re.S)  # JSONP wrapper
    return json.loads(match.group(1) if match else body)


def main(argv: list[str]) -> int:
    guid = os.environ.get("ABN_LOOKUP_GUID", "")
    if not guid:
        print("ABN_LOOKUP_GUID is not set: the app uses the bundled mock registry (ABN_SOURCE=mock).")
        return 0
    abns = [re.sub(r"\D", "", a) for a in argv] or ["53004085616"]
    ROOT.mkdir(parents=True, exist_ok=True)
    for abn in abns:
        data = fetch(abn, guid)
        if data.get("Message"):
            print(f"{abn}: {data['Message']}")
            continue
        (ROOT / f"{abn}.json").write_text(json.dumps(data, indent=1))
        print(f"{abn}: {data.get('EntityName')} ({data.get('EntityTypeName')})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
