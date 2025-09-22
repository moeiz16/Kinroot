// Role → permission matrix, mirrored from docs/API_CONTRACT.md §1.3 (source of truth: backend/accounts/roles.py).
// The web app uses it only in the offline fixture adapter; the live app reads `me.membership.permissions`.
import type { Role } from "../api/types";

const ALL: Role[] = ["owner", "compliance_officer", "partner", "fee_earner", "auditor"];
const matrix: Record<string, Role[]> = {
  "dashboard:read": ALL,
  "insights:read": ["owner", "compliance_officer", "partner", "auditor"],
  "clients:read": ALL,
  "clients:write": ["owner", "compliance_officer", "partner", "fee_earner"],
  "clients:onboard": ["compliance_officer", "partner", "fee_earner"],
  "identity:verify": ["compliance_officer", "partner", "fee_earner"],
  "edd:manage": ["compliance_officer", "partner", "fee_earner"],
  "graph:read": ALL,
  "graph:write": ["compliance_officer", "partner", "fee_earner"],
  "resolution:read": ["owner", "compliance_officer", "partner", "auditor"],
  "resolution:decide": ["compliance_officer"],
  "screening:read": ALL,
  "screening:run": ["compliance_officer", "partner", "fee_earner"],
  "screening:review": ["compliance_officer"],
  "risk:read": ALL,
  "risk:assess": ["compliance_officer", "partner"],
  "risk:override": ["compliance_officer"],
  "methodology:manage": ["compliance_officer"],
  "models:promote": ["compliance_officer"],
  "models:read": ["owner", "compliance_officer", "partner", "auditor"],
  "signoff:compliance": ["compliance_officer"],
  "signoff:senior": ["partner"],
  "monitoring:read": ALL,
  "monitoring:manage": ["compliance_officer"],
  "concerns:raise": ["owner", "compliance_officer", "partner", "fee_earner"],
  "smr:read": ["compliance_officer"],
  "smr:write": ["compliance_officer"],
  "smr:submit": ["compliance_officer"],
  "assistant:use": ["owner", "compliance_officer", "partner", "fee_earner"],
  "audit:read": ["owner", "compliance_officer", "auditor"],
  "training:read": ALL,
  "training:manage": ["owner", "compliance_officer"],
  "retention:manage": ["owner", "compliance_officer"],
  "org:admin": ["owner"],
  "members:manage": ["owner"],
};

export function permissionsFor(role: Role): string[] {
  return Object.entries(matrix)
    .filter(([, roles]) => roles.includes(role))
    .map(([p]) => p);
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Firm administrator",
  compliance_officer: "AML/CTF compliance officer",
  partner: "Partner (senior manager)",
  fee_earner: "Fee earner",
  auditor: "Independent reviewer",
};
