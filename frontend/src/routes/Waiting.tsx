// Phone: the file tray as a list (the "Waiting" tab of the bottom bar).
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/endpoints";
import { Sheet } from "../shell/Drawer";
import { trayHref } from "./BoardHome";
import "./sheets.css";

export default function Waiting() {
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const tray = dash.data?.fileTray ?? [];
  return (
    <Sheet label="Waiting for you">
      <h1 className="title">{tray.length} waiting for you</h1>
      <ul className="client-rows">
        {tray.map((t) => (
          <li key={t.id}>
            <Link to={trayHref(t)} className="client-row" style={{ gridTemplateColumns: "1fr" }}>
              <span>
                <span className="cr-name">{t.title}</span>
                <span className="cr-meta">{t.subtitle}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
