// The folio shell: docket ordering and due wording, folder-tab keys, the queue pager and the command palette.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TrayItem } from "../api/types";
import { daysFromToday } from "../lib/dates";
import { docketRows, dueText } from "../routes/BoardHome";
import { FolioTabs, QueuePager } from "../shell/Folio";
import { renderApp } from "./render";

const slip = (id: string, dueOn: string | null, kind: TrayItem["kind"] = "hit_review"): TrayItem => ({ kind, id, clientId: "c1", title: `Item ${id}`, subtitle: "", dueOn, href: "" });

describe("the docket", () => {
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
    <FolioTabs label="File" tabs={[{ id: "one", label: "One" }, { id: "two", label: "Two", count: 3 }, { id: "three", label: "Three", locked: true }]} active={tab} onTab={setTab} onEscape={onEscape}>
      <p>Showing {tab}</p>
    </FolioTabs>
  );
}

describe("folder tabs", () => {
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

describe("find", () => {
  it("opens with / and goes to part of the file", async () => {
    renderApp("/board");
    await screen.findByRole("navigation", { name: "Main" }, { timeout: 4000 });
    fireEvent.keyDown(window, { key: "/" });
    const input = await screen.findByPlaceholderText("Find a person, company or trust");
    await userEvent.type(input, "activity");
    await userEvent.click(await screen.findByRole("option", { name: "Activity log" }));
    expect(await screen.findByRole("heading", { name: "Activity log" }, { timeout: 4000 })).toBeInTheDocument();
  });
});
