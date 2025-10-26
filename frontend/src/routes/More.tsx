// Every destination as one list (for links and phones that open /more).
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "../lib/auth";
import { navItems, useCounts } from "../shell/AppShell";
import { Page, PageHeader } from "../shell/page";

export default function More() {
  const { can, signOut } = useAuth();
  const counts = useCounts();
  const { main, account } = navItems(can, counts);
  return (
    <Page label="Menu" narrow>
      <PageHeader title="Menu" />
      <ul className="items">
        {[...main, ...account].map((l) => (
          <li key={l.label}>
            <Link to={l.to} className="item more-item">
              <span className="item-main">
                <span className="item-title">{l.label}</span>
              </span>
              <span className="item-end">{l.count ?? ""}</span>
            </Link>
          </li>
        ))}
      </ul>
      <Button variant="line" className="mt-4" onClick={() => void signOut().then(() => location.assign("/sign-in"))}>
        Sign out
      </Button>
    </Page>
  );
}
