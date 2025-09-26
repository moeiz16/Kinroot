import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "./render";

const T = { timeout: 4000 };

describe("public pages", () => {
  it("landing: the board is the hero, with the runtime Tranche 2 line", async () => {
    renderApp("/", null);
    expect(await screen.findByRole("heading", { level: 1, name: /See who is really behind your client/ }, T)).toBeInTheDocument();
    expect(screen.getByText(/Tranche 2 obligations (start in \d+ days|in force since 1 July 2026)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Trust over a company/ })).toBeInTheDocument();
    expect(screen.queryByText(/Explore the demo|Create an account/)).toBeNull();
  });
  it("landing: Open Harbourline's files signs into the sample firm", async () => {
    renderApp("/", null);
    await userEvent.click((await screen.findAllByRole("button", { name: /Open Harbourline’s files/ }, T))[0]!);
    expect(await screen.findByText(/waiting for you/, {}, T)).toBeInTheDocument();
  });
  it("sign-in shows a rule-lined error for a wrong password", async () => {
    renderApp("/sign-in", null);
    await userEvent.type(await screen.findByLabelText("Email", {}, T), "daniel@harbourline.example");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/);
  });
  it("sends signed-out visitors to sign-in", async () => {
    renderApp("/clients", null);
    expect(await screen.findByRole("heading", { name: /Sign in to your firm’s files/ }, T)).toBeInTheDocument();
  });
  it("opens an invitation and shows the firm and role", async () => {
    renderApp("/invite/demo-invite-ferreira", null);
    expect(await screen.findByRole("heading", { name: /Join Harbourline Legal/ }, T)).toBeInTheDocument();
    expect(screen.getByText("Independent reviewer")).toBeInTheDocument();
  });
});

describe("the spine", () => {
  it("shows the restricted reports icon only to the compliance officer", async () => {
    renderApp("/board", "u-daniel");
    const nav = await screen.findByRole("navigation", { name: "Main" }, T);
    expect(within(nav).getByRole("link", { name: /Reports \(restricted\)/ })).toBeInTheDocument();
  });
  it("hides it from a fee earner", async () => {
    renderApp("/board", "u-tom");
    const nav = await screen.findByRole("navigation", { name: "Main" }, T);
    expect(within(nav).queryByRole("link", { name: /Reports/ })).toBeNull();
    expect(within(nav).getByRole("link", { name: /Board/ })).toBeInTheDocument();
  });
});

describe("board and dossier", () => {
  it("the constellation has a text twin listing every client", async () => {
    renderApp("/board");
    const twin = await screen.findByRole("region", { name: "Text version of the board" }, T);
    expect(within(twin).getByText(/Harbour Quay Developments Pty Ltd, client, rated High/)).toBeInTheDocument();
  });
  it("dossier: owners with compounded % and reasons with cited links", async () => {
    renderApp("/clients/c-harbour-quay/summary");
    expect(await screen.findByRole("heading", { name: "Harbour Quay Developments Pty Ltd" }, T)).toBeInTheDocument();
    expect(await screen.findByText("49.6%", {}, T)).toBeInTheDocument();
    expect(screen.getByText("30.4%")).toBeInTheDocument();
    expect(await screen.findByText(/Why this client is rated High/, {}, T)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Show link E-\d\d on the board/ }).length).toBeGreaterThan(0);
  });
  it("dossier: folder tabs move with ] and the Owners tab is the ledger twin", async () => {
    renderApp("/clients/c-harbour-quay/summary");
    await screen.findByRole("tab", { name: "Summary" }, T);
    fireEvent.keyDown(window, { key: "]" });
    expect(await screen.findByRole("heading", { name: "Everyone in the structure" }, T)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Owners/ })).toHaveAttribute("aria-selected", "true");
  });
  it("shows the hatched Restricted tab only to the compliance officer", async () => {
    renderApp("/clients/c-aurelian-shipping/summary", "u-daniel");
    expect(await screen.findByRole("tab", { name: /Restricted/ }, T)).toBeInTheDocument();
  });
  it("never shows the Restricted tab to a fee earner", async () => {
    renderApp("/clients/c-aurelian-shipping/summary", "u-tom");
    await screen.findByRole("tab", { name: "Summary" }, T);
    expect(screen.queryByRole("tab", { name: /Restricted/ })).toBeNull();
  });
});

describe("restricted reports", () => {
  it("gives everyone else the generic not-available page", async () => {
    renderApp("/reports/case-aurelian", "u-tom");
    expect(await screen.findByRole("heading", { name: "This page isn’t available to you." }, T)).toBeInTheDocument();
  });
  it("redacts the grounds for summary access", async () => {
    renderApp("/reports/case-aurelian", "u-margaret");
    expect(await screen.findByRole("img", { name: "Grounds: restricted" }, T)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Draft report" })).toBeNull();
  });
  it("shows the compliance officer the deadline chip and draft", async () => {
    renderApp("/reports/case-aurelian", "u-daniel");
    expect(await screen.findByText(/business day|Due today|Overdue/, {}, T)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Draft report" })).toBeInTheDocument();
  });
});

describe("queues", () => {
  it("fuse: keeping apart needs a reason", async () => {
    renderApp("/fuse/m-reyes");
    await screen.findByRole("heading", { name: "Jonathan P. Reyes and Jonathon Reyes" }, T);
    fireEvent.keyDown(window, { key: "k" });
    expect(await screen.findByText("Give a reason before keeping them apart.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reason"), "Different middle names on the passports.");
    await userEvent.click(screen.getByRole("button", { name: /Keep apart/ }));
    expect(await screen.findByText(/Kept apart\. Your reason is in the activity log\./, {}, T)).toBeInTheDocument();
  });
  it("fuse: the likelihood is stated as N in 100 with the scale bands", async () => {
    renderApp("/fuse/m-reyes");
    expect(await screen.findByRole("img", { name: /Match likelihood 87 in 100/ }, T)).toBeInTheDocument();
  });
  it("screening: a decision needs a reason of 10 characters", async () => {
    renderApp("/screening/h-petrov");
    const btn = await screen.findByRole("button", { name: "Not a match" }, T);
    await userEvent.click(btn);
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 10 characters/);
    await userEvent.type(screen.getByLabelText("Reason (required)"), "Different birth year and nationality.");
    await userEvent.click(screen.getByRole("button", { name: "Not a match" }));
    expect(await screen.findByText("Recorded as not a match.", {}, T)).toBeInTheDocument();
  });
  it("alerts: grouped per client with a before/after stamp", async () => {
    renderApp("/alerts/al-harbour");
    expect(await screen.findByRole("heading", { name: "New director at Kestrel Ventures Ltd" }, T)).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "Point in time" }, T)).toHaveTextContent(/onboarding/);
  });
});

describe("records and settings", () => {
  it("activity log: verify the chain", async () => {
    renderApp("/activity", "u-ruth");
    await userEvent.click(await screen.findByRole("button", { name: /Verify the chain/ }, T));
    expect(await screen.findByText(/Chain verified/, {}, { timeout: 8000 })).toBeInTheDocument();
  }, 12000);
  it("programme: a partners' brief in sentences, not KPI cards", async () => {
    renderApp("/programme", "u-margaret");
    expect(await screen.findByText(/clients are rated high risk/, {}, T)).toBeInTheDocument();
    expect(screen.getByText("Handled by the compliance officer.")).toBeInTheDocument();
  });
  it("members: inviting someone shows the link once", async () => {
    renderApp("/settings/members", "u-olivia");
    await userEvent.click(await screen.findByRole("button", { name: /Invite someone/ }, T));
    await userEvent.type(screen.getByLabelText("Email"), "new.person@harbourline.example");
    await userEvent.click(screen.getByRole("button", { name: "Create the invitation" }));
    expect(((await screen.findByLabelText("Invitation link", {}, T)) as HTMLInputElement).value).toContain("/invite/");
  });
  it("ask: the answer carries numbered citations", async () => {
    renderApp("/ask");
    const input = await screen.findByLabelText("Ask about a person, company or trust", {}, T);
    await userEvent.type(input, "How is Gregory Pell linked to our clients?{Enter}");
    expect(await screen.findByText(/Gregory Pell reaches 3 clients/, {}, T)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Citation 1/ }).length).toBeGreaterThan(0);
  });
  it("onboarding: the client step opens the file and moves to owners", async () => {
    renderApp("/onboard", "u-tom");
    await userEvent.type(await screen.findByLabelText("Legal name", {}, T), "Wharf Street Property Trust");
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /Open the file and continue/ }));
    });
    expect(await screen.findByRole("heading", { name: /Who owns or controls the trust/ }, T)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Add a person/ }));
    expect(screen.getByRole("combobox", { name: "Role" })).toBeInTheDocument();
  });
});

describe("tray", () => {
  it("lists the next decisions for the compliance officer", async () => {
    renderApp("/board", "u-daniel");
    const tray = await screen.findByRole("list", { name: /waiting for you/ }, T);
    await waitFor(() => expect(within(tray).getAllByRole("listitem").length).toBeGreaterThan(2));
  });
});
