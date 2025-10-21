// Phones and the Index: everything waiting on you, as a stack of tickets, earliest due first.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api/endpoints";
import { useAuth } from "../lib/auth";
import { Masthead, Page, PageBody } from "../shell/page";
import { docketRows, Tickets } from "./BoardHome";

export default function Waiting() {
  const { can } = useAuth();
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const cases = useQuery({ queryKey: ["cases"], queryFn: api.cases.list, enabled: can("smr:read") });
  const rows = useMemo(() => docketRows(dash.data?.fileTray ?? [], cases.data?.items ?? []), [dash.data, cases.data]);
  const caption = `${rows.length} waiting for you`;
  return (
    <Page skeleton="register" label="Waiting for you">
      <Masthead size="poster" refLine={<b>Earliest due first</b>} title={caption} />
      <PageBody>
        <Tickets rows={rows} caption={caption} vertical />
      </PageBody>
    </Page>
  );
}
