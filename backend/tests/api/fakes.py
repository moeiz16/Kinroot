"""Small contract-shaped fakes for domain-core calls (B's modules are patched per test)."""

from __future__ import annotations

from datetime import UTC, date, datetime

from kinroot.contracts import (
    AlertView,
    GraphEdge,
    GraphNode,
    GraphView,
    ListEntryView,
    MatchReason,
    Page,
    ScreeningHitView,
)

NOW = datetime(2025, 10, 1, 9, 30, tzinfo=UTC)


def entry(list_kind: str = "sanctions", entry_id: str = "SAMPLE-SAN-0007") -> ListEntryView:
    return ListEntryView(
        id=entry_id,
        list_kind=list_kind,
        name="Aurelian Maritime FZCO",
        aliases=[],
        birth_date=None,
        countries=["AE"],
        programs=["SAMPLE"],
        source="bundled-sample@2025.10",
    )


def hit(
    client_id: str,
    *,
    status: str = "pending",
    list_kind: str = "sanctions",
    reason: str | None = None,
    hit_id: str = "11111111-1111-1111-1111-111111111111",
) -> ScreeningHitView:
    return ScreeningHitView(
        id=hit_id,
        client_id=client_id,
        party_id="p1",
        party_name="Aurelian Maritime FZE",
        entry=entry(list_kind),
        score=0.91,
        reasons=[MatchReason("name_jaro_winkler", "Names are almost identical", "for", 1.2, "0.95")],
        status=status,
        created_at=NOW,
        reviewed_by="Daniel Cho" if reason else None,
        review_reason=reason,
    )


def page(items: list) -> Page:
    return Page(items=items, total=len(items))


def graph_view(focus: str) -> GraphView:
    return GraphView(
        focus_id=focus,
        as_of=date(2025, 10, 1),
        depth=6,
        graph_version=7,
        nodes=[
            GraphNode(
                id=focus,
                kind="company",
                label="Harbour Quay Developments Pty Ltd",
                jurisdiction="AU",
                identifiers={"acn": "612 345 670"},
                flags=["client"],
                client_id="c1",
                level=0,
            ),
            GraphNode(
                id="n2", kind="company", label="Kestrel Ventures Ltd", jurisdiction="VG", flags=["offshore"], level=1
            ),
        ],
        edges=[
            GraphEdge(
                id="e1",
                source="n2",
                target=focus,
                kind="ownership",
                label="100%",
                pct=100.0,
                interest="shares",
                valid_from=date(2019, 6, 1),
                source_ref="manual",
            )
        ],
    )


def alert(client_id: str, kind: str = "ownership_change") -> AlertView:
    return AlertView(
        id="a1",
        client_id=client_id,
        client_name="Ironbark Ventures Pty Ltd",
        kind=kind,
        severity="warning",
        title="New 40% owner",
        body="Cayman Ridge Holdings Ltd became a 40% owner.",
        evidence=[{"type": "edge", "id": "e9"}],
        status="open",
        created_at=NOW,
    )
