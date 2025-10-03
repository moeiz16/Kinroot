"""Investigation assistant: cited answers from Cypher tools, permission checks, tipping-off and grounding."""

from __future__ import annotations

import json
from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from django.test import override_settings
from django.utils import timezone

from assistant import agent
from assistant import api as assistant
from kinroot.contracts import Citation

pytestmark = pytest.mark.django_db
ALL = frozenset({"assistant:use", "graph:read", "screening:read", "risk:read"})
FEE_EARNER = frozenset({"assistant:use", "graph:read", "screening:read", "risk:read"})


def cited_ids(answer):
    return {c.id for c in answer.citations}


def test_who_controls_cites_the_ownership_edges(hq):
    a = assistant.ask(hq.org_id, "Who controls Harbour Quay Developments?", hq.actor("co"), permissions=ALL)
    assert a.grounded and a.mode == "offline"
    assert "Ava Calder owns 49.6%" in a.answer and "[1]" in a.answer
    assert str(hq.r["kes>hq"].id) in cited_ids(a)
    assert a.steps[0].tool == "who_controls" and a.steps[0].label.startswith("Traced the owners")
    assert str(hq.p["ava"].id) in a.highlight["nodeIds"]
    assert agent.grounded(a.answer, a.citations)


def test_client_context_is_the_default_subject(hq):
    a = assistant.ask(
        hq.org_id, "Who is behind this client?", hq.actor("co"), permissions=ALL, client_id=hq.c["harbour-quay"].id
    )
    assert a.grounded and "Ben Okafor" in a.answer


def test_path_between_two_named_parties(hq):
    a = assistant.ask(hq.org_id, "How is Ben Okafor connected to Gregory Pell?", hq.actor("co"), permissions=ALL)
    assert a.grounded and a.steps[0].tool == "path_between"
    assert "3 steps" in a.answer and str(hq.r["bell>kes"].id) in cited_ids(a)


def test_changes_since_date(hq):
    a = assistant.ask(
        hq.org_id, "What changed in Harbour Quay Developments since 2020-06-01?", hq.actor("co"), permissions=ALL
    )
    assert a.grounded and a.steps[0].tool == "changes_since"
    assert "Kestrel Ventures Ltd" in a.answer and str(hq.r["kes>hq"].id) in cited_ids(a)


def test_no_changes_is_a_grounded_empty_answer(hq):
    a = assistant.ask(
        hq.org_id, "What changed in Harbour Quay Developments in the last 30 days?", hq.actor("co"), permissions=ALL
    )
    assert a.grounded and a.citations == [] and "No ownership or control changes" in a.answer


def test_risk_reasons_cite_evidence(hq):
    from risk import api as risk

    risk.assess_client(hq.org_id, hq.c["harbour-quay"].id, hq.actor("co"))
    a = assistant.ask(hq.org_id, "Why is Harbour Quay Developments rated high risk?", hq.actor("co"), permissions=ALL)
    assert a.grounded and a.steps[0].tool == "risk_reasons" and "points" in a.answer


def test_screening_needs_permission(hq):
    perms = frozenset({"assistant:use", "graph:read"})
    a = assistant.ask(
        hq.org_id, "Is anyone in Harbour Quay Developments on a sanctions list?", hq.actor("co"), permissions=perms
    )
    assert not a.grounded and a.answer == agent.NOT_PERMITTED and a.citations == []


def test_without_assistant_permission_nothing_is_read(hq):
    a = assistant.ask(
        hq.org_id, "Who controls Harbour Quay Developments?", hq.actor("co"), permissions=frozenset({"graph:read"})
    )
    assert a.answer == agent.NOT_PERMITTED and a.steps == []


def test_unanswerable_question_is_withheld(hq):
    a = assistant.ask(hq.org_id, "What is the weather in Sydney?", hq.actor("co"), permissions=ALL)
    assert not a.grounded and a.answer == agent.SAFE_MESSAGE


def test_assistant_never_reveals_case_content(hq):
    from cases.models import Case

    Case.objects.create(
        org=hq.org,
        client=hq.c["harbour-quay"],
        title="Structuring suspicion",
        grounds="SECRET-GROUNDS-TEXT",
        opened_by=None,
        opened_at=timezone.now(),
        deadline_on=timezone.localdate() + timedelta(days=3),
    )
    for q in [
        "Is there a suspicious matter report on Harbour Quay Developments?",
        "Who controls Harbour Quay Developments?",
        "Why is Harbour Quay Developments rated high risk?",
        "What changed in Harbour Quay Developments since 2015-01-01?",
    ]:
        a = assistant.ask(hq.org_id, q, hq.actor("fe"), permissions=FEE_EARNER)
        text = a.answer + " ".join(c.label for c in a.citations)
        assert (
            "SECRET-GROUNDS-TEXT" not in text and "suspicious matter" not in text.lower() and "case" not in text.lower()
        )
    assert set(agent.tools.PERMISSIONS) == {
        "find_party",
        "who_controls",
        "path_between",
        "changes_since",
        "screening_status",
        "risk_reasons",
    }


def test_question_length_and_history_are_per_user(hq):
    with pytest.raises(ValueError):
        assistant.ask(hq.org_id, "x" * 501, hq.actor("co"), permissions=ALL)
    assistant.ask(hq.org_id, "Who controls Bellmere Holdings?", hq.actor("co"), permissions=ALL)
    assert len(assistant.history(hq.org_id, hq.users["co"].id)) == 1
    other = hq.user("tom", "fee_earner")
    assert assistant.history(hq.org_id, other.id) == []


def test_suggested_questions_use_real_names(hq):
    qs = assistant.suggested_questions(hq.org_id, hq.c["harbour-quay"].id)
    assert qs[0] == "Who controls Harbour Quay Developments Pty Ltd?"


def test_grounding_rejects_uncited_or_out_of_range_markers():
    c = [Citation(type="edge", id="e1", label="x")]
    assert agent.grounded("Ava owns 49.6% of Harbour Quay [1].", c)
    assert not agent.grounded("Ava owns it. She is the appointor [1].", c)
    assert not agent.grounded("Ava owns it [2].", c)
    assert agent.grounded("Hon. Julian Whitfield is a director [1].", c)


def test_date_parsing():
    today = date(2025, 10, 15)
    assert agent.parse_since("since 1 March 2025", today) == date(2025, 3, 1)
    assert agent.parse_since("in the last 90 days", today) == today - timedelta(days=90)
    assert agent.parse_since("this quarter", today) == today - timedelta(days=91)
    assert agent.parse_since("who owns it", today) is None


def _fake_completion(final_text):
    calls = {"n": 0}

    def completion(**kwargs):
        calls["n"] += 1
        if "tools" in kwargs and calls["n"] == 1:
            fn = (
                SimpleNamespace(name="who_controls", arguments=json.dumps({"party_id": kwargs["_party"]}))
                if "_party" in kwargs
                else None
            )
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content="", tool_calls=[SimpleNamespace(id="t1", function=fn)])
                    )
                ]
            )
        if "tools" in kwargs:
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="", tool_calls=[]))])
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=final_text, tool_calls=None))])

    return completion


@pytest.mark.parametrize(
    ("draft", "accepted"),
    [
        ("Ava Calder owns 49.6% of Harbour Quay [1].", True),
        ("Ava Calder owns 99% of it [1].", False),
        ("Ava owns it.", False),
    ],
)
def test_cloud_mode_keeps_only_grounded_drafts(hq, monkeypatch, draft, accepted):
    import sys

    party = str(hq.p["hq"].id)
    fake = _fake_completion(draft)
    monkeypatch.setitem(
        sys.modules, "litellm", SimpleNamespace(completion=lambda **kw: fake(**{**kw, "_party": party}))
    )
    with override_settings(KINROOT={**__import__("django.conf").conf.settings.KINROOT, "LLM_FAKE": False}):
        a = assistant.ask(hq.org_id, "Who controls Harbour Quay Developments?", hq.actor("co"), permissions=ALL)
    assert a.mode == "cloud" and a.grounded
    assert (a.answer == draft) is accepted
