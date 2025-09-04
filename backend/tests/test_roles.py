"""RBAC matrix invariants (tipping-off: no role reads SMRs except the compliance officer)."""

from accounts.roles import ALL_PERMISSIONS, ROLE_PERMISSIONS, has_permission


def test_every_granted_permission_is_known():
    for perms in ROLE_PERMISSIONS.values():
        assert perms <= set(ALL_PERMISSIONS)


def test_only_compliance_officer_reads_smr_register():
    readers = {role for role in ROLE_PERMISSIONS if has_permission(role, "smr:read")}
    assert readers == {"compliance_officer"}


def test_everyone_can_raise_a_concern():
    assert all(has_permission(role, "concerns:raise") for role in ROLE_PERMISSIONS if role != "auditor")


def test_auditor_is_read_only():
    writes = {p for p in ROLE_PERMISSIONS["auditor"] if not p.endswith(":read")}
    assert writes == set()


def test_senior_approval_is_partner_only():
    assert {r for r in ROLE_PERMISSIONS if has_permission(r, "signoff:senior")} == {"partner"}
