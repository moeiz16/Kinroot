"""Plain-language labels for audit actions (activity feeds, CSV export, case timelines)."""

from __future__ import annotations

from typing import Any

LABELS = {
    "auth.signed_up": "Created the firm's account",
    "auth.login": "Signed in",
    "auth.login_failed": "Failed sign-in attempt",
    "auth.logout": "Signed out",
    "auth.switched_org": "Switched firm",
    "auth.password_changed": "Changed password",
    "org.updated": "Updated firm details",
    "member.role_changed": "Changed a member's role",
    "member.removed": "Removed a member",
    "invitation.created": "Invited a new member",
    "invitation.revoked": "Revoked an invitation",
    "invitation.accepted": "Joined the firm",
    "settings.updated": "Updated firm settings",
    "retention.run_requested": "Requested a retention review",
    "retention.disposed": "Disposed of records past their retention period",
    "training.recorded": "Recorded AML/CTF training",
    "client.created": "Started onboarding {client}",
    "client.updated": "Updated {client}",
    "client.submitted": "Submitted {client} for screening and risk assessment",
    "client.exited": "Ended the relationship with {client}",
    "client.exit_held": "Exit for {client} is awaiting the compliance officer",
    "client.blocked": "Paused work on {client}",
    "party.created": "Added a party to a structure",
    "party.updated": "Updated a party",
    "party.merged": "Merged duplicate records",
    "party.split": "Split a merged record",
    "relationship.created": "Recorded an ownership or control link",
    "relationship.updated": "Updated an ownership or control link",
    "relationship.ended": "Ended an ownership or control link",
    "relationship.deleted": "Deleted a mistaken link",
    "registry.imported": "Imported registry details for {client}",
    "document.uploaded": "Uploaded an identity document",
    "document.downloaded": "Downloaded an identity document",
    "identity.verified": "Ran an identity check",
    "consent.recorded": "Recorded consent to identity checks",
    "communication.sent": "Sent a message to {client}",
    "communication.held": "Message to {client} is awaiting the compliance officer",
    "edd.measure_updated": "Updated enhanced due diligence for {client}",
    "edd.signoff_approve": "Signed off {client}",
    "edd.signoff_reject": "Returned {client} for more work",
    "review.completed": "Completed a periodic review of {client}",
    "screening.requested": "Requested screening for {client}",
    "screening.rescreen_requested": "Requested a re-screen of all clients",
    "screening.hit_reviewed": "Screening match reviewed",
    "resolution.merged": "Merged duplicate records",
    "resolution.decided": "Reviewed a possible duplicate",
    "risk.assessed": "Risk assessed",
    "risk.overridden": "Risk rating overridden",
    "hold.placed": "Placed a hold on client contact",
    "hold.released": "Released a hold on client contact",
    "concern.raised": "Raised an internal concern",
    "case.opened": "Opened a case",
}


def label_for(action: str, metadata: dict[str, Any] | None = None, client_name: str | None = None) -> str:
    template = LABELS.get(action)
    if template is None:
        area, _, verb = action.partition(".")
        template = f"{area.capitalize()}: {verb.replace('_', ' ')}" if verb else action
    return template.replace("{client}", client_name or "a client")
