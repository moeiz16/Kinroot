import { Link } from "react-router";
import { Caption, Folio, FolioBody } from "../shell/Folio";

/** The same words for missing, forbidden and restricted records, so nothing reveals that a record exists. */
export function NotAvailable() {
  return (
    <Folio label="Not available" width="narrow">
      <Caption refLine={<span>Kinroot</span>} title="This page isn’t available to you." />
      <FolioBody>
        <p className="lede" style={{ fontSize: 15.5, marginTop: 0 }}>
          It may not exist, or you may not have access to it. If you think you should, ask your compliance officer.
        </p>
        <p style={{ marginTop: 22 }}>
          <Link className="link" to="/board">
            Back to the board
          </Link>
        </p>
      </FolioBody>
    </Folio>
  );
}
export default NotAvailable;
