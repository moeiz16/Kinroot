import { Link } from "react-router";
import { Page, PageHeader } from "../shell/page";

/** The same words for missing, forbidden and restricted records, so nothing reveals that a record exists. */
export function NotAvailable() {
  return (
    <Page label="Not available" narrow>
      <PageHeader title="This page isn’t available to you." />
      <p className="note-info">Ask your compliance officer if you think you need it.</p>
      <p style={{ marginTop: 16 }}>
        <Link className="link" to="/board">
          Go home
        </Link>
      </p>
    </Page>
  );
}
export default NotAvailable;
