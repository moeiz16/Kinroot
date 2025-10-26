// Reviews: one place with three queues, each its own route. The strip shows the queues this person can open.
import { Link, useLocation } from "react-router";
import { useAuth } from "../lib/auth";
import { useCounts } from "../shell/AppShell";
import { PageHeader, useTitle } from "../shell/page";

export function ReviewsHeader() {
  const { can } = useAuth();
  const counts = useCounts();
  const { pathname } = useLocation();
  const tabs = [
    { to: "/screening", label: "Screening", n: can("screening:review") ? counts.screeningBacklog : undefined },
    ...(can("resolution:read") ? [{ to: "/fuse", label: "Duplicates", n: counts.mergeQueue }] : []),
    { to: "/alerts", label: "Alerts", n: counts.openAlerts },
  ];
  const here = tabs.find((t) => pathname.startsWith(t.to));
  useTitle(here ? here.label : "Reviews");
  return (
    <>
      <PageHeader title="Reviews" />
      <nav className="section-words" aria-label="Review queues">
        {tabs.map((t) => (
          <Link key={t.to} to={t.to} className="section-word" data-state={pathname.startsWith(t.to) ? "active" : undefined} aria-current={pathname.startsWith(t.to) ? "page" : undefined}>
            {t.label}
            {!!t.n && <span className="n">{t.n}</span>}
          </Link>
        ))}
      </nav>
    </>
  );
}
