import { Link } from "react-router";
import { Masthead, Page, PageBody } from "../shell/page";

/** The same words for missing, forbidden and restricted records, so nothing reveals that a record exists. */
export function NotAvailable() {
  return (
    <Page skeleton="form" label="Not available">
      <Masthead size="page" refLine={<b>Kinroot</b>} title="This page isn’t available to you." />
      <PageBody>
        <p className="lede">It may not exist, or you may not have access to it. If you think you should, ask your compliance officer.</p>
        <p>
          <Link className="link" to="/board">
            Back to your desk
          </Link>
        </p>
      </PageBody>
    </Page>
  );
}
export default NotAvailable;
