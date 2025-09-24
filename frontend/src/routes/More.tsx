// Phone: everything the spine holds that the bottom bar doesn't.
import { BellRing, ClipboardCheck, FileLock2, GitMerge, ScrollText, Settings2, ShieldAlert, UserPlus } from "lucide-react";
import { Link } from "react-router";
import { useAuth } from "../lib/auth";
import { Sheet } from "../shell/Drawer";
import "./sheets.css";

export default function More() {
  const { can, signOut, me } = useAuth();
  const links = [
    can("clients:onboard") && { to: "/onboard", label: "Onboard a client", icon: <UserPlus /> },
    can("resolution:read") && { to: "/fuse", label: "Fuse or split", icon: <GitMerge /> },
    { to: "/screening", label: "Screening", icon: <ShieldAlert /> },
    { to: "/alerts", label: "Monitoring alerts", icon: <BellRing /> },
    can("smr:read") && { to: "/reports", label: "Reports (restricted)", icon: <FileLock2 /> },
    { to: "/programme", label: "Compliance programme", icon: <ClipboardCheck /> },
    can("audit:read") && { to: "/activity", label: "Activity log", icon: <ScrollText /> },
    { to: "/settings/firm", label: "Settings", icon: <Settings2 /> },
  ].filter(Boolean) as { to: string; label: string; icon: React.ReactNode }[];
  return (
    <Sheet label="More">
      <div className="eyebrow">{me?.activeOrg?.name}</div>
      <h1 className="title">More</h1>
      <ul className="more-list">
        {links.map((l) => (
          <li key={l.to}>
            <Link to={l.to}>
              {l.icon}
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
      <button className="btn btn-line" style={{ marginTop: 20 }} onClick={() => void signOut().then(() => location.assign("/sign-in"))}>
        Sign out
      </button>
    </Sheet>
  );
}
