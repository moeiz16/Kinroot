// Phone: the docket on its own (the "Waiting" tab of the bottom bar).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api/endpoints";
import { useAuth } from "../lib/auth";
import { Caption, Folio, FolioBody } from "../shell/Folio";
import { Docket, docketRows } from "./BoardHome";

export default function Waiting() {
  const { can } = useAuth();
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const cases = useQuery({ queryKey: ["cases"], queryFn: api.cases.list, enabled: can("smr:read") });
  const rows = useMemo(() => docketRows(dash.data?.fileTray ?? [], cases.data?.items ?? []), [dash.data, cases.data]);
  const caption = `${rows.length} waiting for you`;
  return (
    <Folio label="Waiting for you" width="full">
      <Caption refLine={<span>The docket · earliest due first</span>} title={caption} />
      <FolioBody>
        <Docket rows={rows} caption={caption} />
      </FolioBody>
    </Folio>
  );
}
