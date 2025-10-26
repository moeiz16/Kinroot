// Search: people, companies and trusts in the firm's files, and every page. Opens with `/` or ⌘K anywhere, or from
// Search in the top bar.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { api } from "../api/endpoints";
import type { GraphNode } from "../api/types";
import { useAuth } from "../lib/auth";
import { ratingLook } from "../lib/format";
import { KindGlyph } from "./chart";

const listeners = new Set<() => void>();
/** Open search from anywhere. */
export function openFind(): void {
  listeners.forEach((l) => l());
}

function Glyph({ kind }: { kind: string }) {
  return <KindGlyph kind={kind} size={15} />;
}

export function CommandPalette() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data = [] } = useQuery({ queryKey: ["search", q], queryFn: () => api.graph.search(q, 8), enabled: open && q.trim().length > 1 });

  useEffect(() => {
    const show = () => setOpen(true);
    listeners.add(show);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      listeners.delete(show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const go = (to: string) => {
    setOpen(false);
    setQ("");
    nav(to);
  };
  const party = (n: GraphNode) => go(n.clientId ? `/clients/${n.clientId}/summary` : `/ask?q=${encodeURIComponent(`How is ${n.label} linked to our clients?`)}`);
  const places = [
    { to: "/board", label: "Home" },
    { to: "/clients", label: "Clients" },
    can("clients:onboard") && { to: "/onboard", label: "New client" },
    can("resolution:read") && { to: "/fuse", label: "Duplicates" },
    { to: "/screening", label: "Screening" },
    { to: "/alerts", label: "Alerts" },
    can("smr:read") && { to: "/reports", label: "Reports" },
    can("assistant:use") && { to: "/ask", label: "Ask" },
    { to: "/programme", label: "Programme" },
    can("audit:read") && { to: "/activity", label: "Activity log" },
    { to: "/settings/firm", label: "Settings" },
  ].filter(Boolean) as { to: string; label: string; key?: string }[];
  const needle = q.trim().toLowerCase();
  const shown = places.filter((p) => !needle || p.label.toLowerCase().includes(needle));

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
      title="Search"
      description="Find a person, company or trust, or go to a page"
      shouldFilter={false}
      className="top-[18%] translate-y-0 sm:max-w-[620px]"
    >
      <CommandInput value={q} onValueChange={setQ} placeholder="Find a person, company or trust" aria-label="Find a person, company or trust" />
      <CommandList>
        <CommandEmpty>{q.trim().length > 1 ? "No one by that name." : "Type a name."}</CommandEmpty>
        {data.length > 0 && (
          <CommandGroup heading="Parties">
            {data.map((n) => (
              <CommandItem key={n.id} value={`party-${n.id}`} onSelect={() => party(n)}>
                <Glyph kind={n.kind} />
                <span className="min-w-0 flex-1">
                  <b className="block truncate font-medium">{n.label}</b>
                  <small className="text-muted">{n.clientId ? `Client · ${ratingLook(n.riskRating).word}` : n.kind === "person" ? "Person" : n.kind === "trust" ? "Trust" : "Company"}</small>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {shown.length > 0 && (
          <CommandGroup heading="Pages">
            {shown.map((p) => (
              <CommandItem key={p.to} value={`go-${p.to}`} onSelect={() => go(p.to)}>
                {p.label}
                {p.key && <CommandShortcut>{p.key}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
