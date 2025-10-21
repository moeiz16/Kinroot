// The Index as a page (for links and phones that open /more): every destination as a poster word.
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "../lib/auth";
import { navItems, useCounts } from "../shell/AppShell";
import { Masthead, Page, PageBody } from "../shell/page";

export default function More() {
  const { can, signOut, me } = useAuth();
  const counts = useCounts();
  const { work, decide, record } = navItems(can, counts);
  return (
    <Page skeleton="register" label="Index">
      <Masthead size="poster" refLine={<b>{me?.activeOrg?.name}</b>} title="Index" />
      <PageBody>
        <ol className="more-list">
          {[...work, ...decide, ...record].map((l, i) => (
            <li key={l.to}>
              <Link to={l.to}>
                <span className="il-n">{String(i + 1).padStart(2, "0")}</span>
                <span className="ml-word">{l.label}</span>
                {!!l.count && <span className="mono">{l.count}</span>}
              </Link>
            </li>
          ))}
        </ol>
        <Button className="more-btn" onClick={() => void signOut().then(() => location.assign("/sign-in"))}>
          Sign out
        </Button>
      </PageBody>
    </Page>
  );
}
