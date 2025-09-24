import { Link } from "react-router";
import { Sheet } from "../shell/Drawer";

/** The same words for missing, forbidden and restricted records, so nothing reveals that a record exists. */
export function NotAvailable() {
  return (
    <Sheet label="Not available" width={520}>
      <div className="eyebrow">Kinroot</div>
      <h1 className="title">This page isn’t available to you.</h1>
      <p className="lede" style={{ fontSize: 15.5 }}>
        It may not exist, or you may not have access to it. If you think you should, ask your compliance officer.
      </p>
      <p style={{ marginTop: 22 }}>
        <Link className="link" to="/board">
          Back to the board
        </Link>
      </p>
    </Sheet>
  );
}
export default NotAvailable;
