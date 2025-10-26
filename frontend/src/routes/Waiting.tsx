// Everything waiting on you as one list, earliest due first (phones and direct links).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api/endpoints";
import { useAuth } from "../lib/auth";
import { Page, PageHeader, useTitle } from "../shell/page";
import { docketRows, Tickets } from "./BoardHome";

export default function Waiting() {
  const { can } = useAuth();
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const cases = useQuery({ queryKey: ["cases"], queryFn: api.cases.list, enabled: can("smr:read") });
  const rows = useMemo(() => docketRows(dash.data?.fileTray ?? [], cases.data?.items ?? []), [dash.data, cases.data]);
  useTitle("Waiting for you");
  return (
    <Page label="Waiting for you" narrow>
      <PageHeader title="Waiting for you" count={rows.length} />
      <Tickets rows={rows} caption={`${rows.length} waiting for you`} />
    </Page>
  );
}
