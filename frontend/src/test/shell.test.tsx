// The shell: ticket ordering and due wording, section-word keys, the queue pager, the trail, the Index and Find.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TrayItem } from "../api/types";
import { daysFromToday } from "../lib/dates";
import { docketRows, dueText } from "../routes/BoardHome";
import { QueuePager, SectionTabs } from "../shell/page";
import { clearTrail, hopKey, recordHop, setTrailOwner, useTrail } from "../shell/trail";
import { rounded } from "../graph/engine";
import { renderHook, act } from "@testing-library/react";
import { renderApp } from "./render";

const slip = (id: string, dueOn: string | null, kind: TrayItem["kind"] = "hit_review"): TrayItem => ({ kind, id, clientId: "c1", title: `Item ${id}`, subtitle: "", dueOn, href: "" });

describe("the ticket rail", () => {
  it("words due dates from today", () => {
    expect(dueText(null)).toEqual({ text: "—", late: false });
    expect(dueText(daysFromToday(0)).text).toBe("Due today");
    expect(dueText(daysFromToday(1)).text).toBe("Tomorrow");
    expect(dueText(daysFromToday(4)).text).toBe("In 4 days");
    expect(dueText(daysFromToday(-2))).toEqual({ text: "2 days late", late: true });
  });
  it("puts the earliest due first and undated items last", () => {
    const rows = docketRows([slip("a", null), slip("b", daysFromToday(3)), slip("c", daysFromToday(-1))], []);
    expect(rows.map((r) => r.title)).toEqual(["Item c", "Item b", "Item a"]);
    expect(rows[0]!.href).toBe("/screening/c");
  });
  it("adds open report deadlines, never filed ones", () => {
    const base = { clientId: "c1", status: "open", smrStatus: "draft" };
    const rows = docketRows([], [
      { ...base, id: "k1", title: "SMR-2025-003 · X", deadlineOn: daysFromToday(2) },
      { ...base, id: "k2", title: "SMR-2025-001 · Y", deadlineOn: daysFromToday(2), smrStatus: "submitted" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "report", title: "SMR-2025-003", href: "/reports/k1" });
  });
});

function Tabbed({ onEscape }: { onEscape?: () => void }) {
  const [tab, setTab] = useState("one");
  return (
    <SectionTabs label="File" tabs={[{ id: "one", label: "One" }, { id: "two", label: "Two", count: 3 }, { id: "three", label: "Three", locked: true }]} active={tab} onTab={setTab} onEscape={onEscape}>
      <p>Showing {tab}</p>
    </SectionTabs>
  );
}

describe("section words", () => {
  it("move with ] and [ and close with Esc", async () => {
    const esc = vi.fn();
    render(<Tabbed onEscape={esc} />);
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { key: "]" });
    expect(await screen.findByText("Showing two")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Two/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { key: "[" });
    expect(await screen.findByText("Showing one")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(esc).toHaveBeenCalledOnce();
  });
  it("name the list of tabs after the file", () => {
    render(<Tabbed />);
    expect(screen.getByRole("tablist", { name: "File sections" })).toBeInTheDocument();
  });
});

describe("queue pager", () => {
  const items = [
    { id: "a", title: "First pair" },
    { id: "b", title: "Second pair" },
    { id: "c", title: "Third pair" },
  ];
  it("says where you are and steps both ways, wrapping at the ends", async () => {
    const pick = vi.fn();
    render(<QueuePager label="Possible duplicates" items={items} current="a" onPick={pick} />);
    expect(screen.getByRole("button", { name: /Possible duplicates: 1 of 3/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next in the queue" }));
    expect(pick).toHaveBeenLastCalledWith("b");
    await userEvent.click(screen.getByRole("button", { name: "Previous in the queue" }));
    expect(pick).toHaveBeenLastCalledWith("c");
  });
  it("lists the whole queue to jump to", async () => {
    const pick = vi.fn();
    render(<QueuePager label="Possible duplicates" items={items} current="a" onPick={pick} />);
    await userEvent.click(screen.getByRole("button", { name: /1 of 3/ }));
    const list = await screen.findByRole("listbox");
    await userEvent.click(within(list).getByText("Third pair"));
    expect(pick).toHaveBeenCalledWith("c");
  });
});

describe("the trail", () => {
  it("adds new places and cuts back to a place already on it", () => {
    setTrailOwner("test-user");
    clearTrail();
    const { result } = renderHook(() => useTrail());
    act(() => {
      recordHop({ key: "/board", path: "/board", label: "Desk", kind: "page" });
      recordHop({ key: "/clients", path: "/clients", label: "Clients", kind: "page" });
      recordHop({ key: "/clients/c1/summary", path: "/clients/c1/summary", label: "Harbour Quay", kind: "company" });
    });
    expect(result.current.map((h) => h.label)).toEqual(["Desk", "Clients", "Harbour Quay"]);
    act(() => recordHop({ key: "/clients", path: "/clients", label: "Clients", kind: "page" }));
    expect(result.current.map((h) => h.label)).toEqual(["Desk", "Clients"]);
  });
  it("treats a dossier's sections as one place", () => {
    expect(hopKey("/clients/c1/owners")).toBe("/clients/c1");
    expect(hopKey("/clients/c1")).toBe("/clients/c1");
    expect(hopKey("/settings/members")).toBe("/settings");
  });
  it("keeps the last six places", () => {
    setTrailOwner("test-user-2");
    clearTrail();
    const { result } = renderHook(() => useTrail());
    act(() => {
      for (let i = 0; i < 9; i++) recordHop({ key: `/p${i}`, path: `/p${i}`, label: `P${i}`, kind: "page" });
    });
    expect(result.current).toHaveLength(6);
    expect(result.current[0]!.label).toBe("P3");
  });
  it("shows your path through the files in the bar", async () => {
    renderApp("/board");
    const trail = await screen.findByRole("navigation", { name: "Your trail" }, { timeout: 4000 });
    expect(within(trail).getByText("Desk")).toBeInTheDocument();
  });
});

describe("chart lines", () => {
  it("round the corners of an elbow", () => {
    const d = rounded([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 80, y: 50 }, { x: 80, y: 100 }], 9);
    expect(d.startsWith("M0,0")).toBe(true);
    expect((d.match(/Q/g) ?? []).length).toBe(2);
    expect(d.endsWith("L80,100")).toBe(true);
  });
});

describe("the index", () => {
  it("opens with the Index button and lists every place", async () => {
    renderApp("/board");
    await userEvent.click(await screen.findByRole("button", { name: "Open the index of every page" }, { timeout: 4000 }));
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: /Clients/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Activity log/ })).toBeInTheDocument();
  });
  it("opens with the . key", async () => {
    renderApp("/board");
    await screen.findByRole("button", { name: "Open the index of every page" }, { timeout: 4000 });
    fireEvent.keyDown(window, { key: "." });
    expect(await screen.findByRole("dialog", { name: "Index" })).toBeInTheDocument();
  });
});

describe("find", () => {
  it("opens with / and goes to part of the file", async () => {
    renderApp("/board");
    await screen.findByRole("button", { name: "Find a person, company or trust" }, { timeout: 4000 });
    fireEvent.keyDown(window, { key: "/" });
    const input = await screen.findByPlaceholderText("Find a person, company or trust");
    await userEvent.type(input, "activity");
    await userEvent.click(await screen.findByRole("option", { name: "Activity log" }));
    expect(await screen.findByRole("heading", { name: "Activity log" }, { timeout: 4000 })).toBeInTheDocument();
  });
});
