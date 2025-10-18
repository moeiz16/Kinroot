// Phone: everything the spine holds that the bottom bar doesn't (also offered as a sheet from the bottom bar).
import { BellRing, ClipboardCheck, FileLock2, GitMerge, ScrollText, Settings2, ShieldAlert, UserPlus } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "../lib/auth";
import { Caption, Folio, FolioBody } from "../shell/Folio";

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
    <Folio label="More" width="full">
      <Caption refLine={<span>{me?.activeOrg?.name}</span>} title="More" />
      <FolioBody>
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
        <Button style={{ marginTop: 20 }} onClick={() => void signOut().then(() => location.assign("/sign-in"))}>
          Sign out
        </Button>
      </FolioBody>
    </Folio>
  );
}
