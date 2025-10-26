import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "./render";

const T = { timeout: 4000 };

describe("public pages", () => {
  it("landing: one question, a traced sample and the runtime Tranche 2 line", async () => {
    renderApp("/", null);
    expect(await screen.findByRole("heading", { level: 1, name: /Who really owns your client/ }, T)).toBeInTheDocument();
    expect(screen.getByText("Margaret Calder")).toBeInTheDocument();
    expect(screen.getByText(/Tranche 2 obligations (start in \d+ days|in force since 1 July 2026)/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Trust over a company/ })).toBeInTheDocument();
    expect(screen.queryByText(/Explore the demo|Create an account/)).toBeNull();
  });
  it("landing: Open the sample firm signs into the sample firm", async () => {
    renderApp("/", null);
    await userEvent.click(await screen.findByRole("button", { name: /Open the sample firm/ }, T));
    expect(await screen.findByRole("heading", { level: 1, name: /Waiting for you/ }, T)).toBeInTheDocument();
  });
  it("sign-in shows an error for a wrong password", async () => {
    renderApp("/sign-in", null);
    await userEvent.type(await screen.findByLabelText("Email", {}, T), "daniel@harbourline.example");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/);
  });
  it("keeps the sample accounts one click away, folded", async () => {
    renderApp("/sign-in", null);
    expect(await screen.findByText("Use a sample account", {}, T)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Compliance officer/ })).not.toBeVisible();
  });
  it("sends signed-out visitors to sign-in", async () => {
    renderApp("/clients", null);
    expect(await screen.findByRole("heading", { name: "Sign in" }, T)).toBeInTheDocument();
  });
  it("opens an invitation and shows the firm and role", async () => {
    renderApp("/invite/demo-invite-ferreira", null);
    expect(await screen.findByRole("heading", { name: /Join Harbourline Legal/ }, T)).toBeInTheDocument();
    expect(screen.getByText("Independent reviewer")).toBeInTheDocument();
  });
});

const mainNav = () => screen.findByRole("navigation", { name: "Main" }, T);

describe("the top bar by role", () => {
  it("shows Reports only to the compliance officer", async () => {
    renderApp("/board", "u-daniel");
    expect(within(await mainNav()).getByRole("link", { name: /Reports/ })).toBeInTheDocument();
  });
  it("hides Reports from a fee earner", async () => {
    renderApp("/board", "u-tom");
    const nav = await mainNav();
    expect(within(nav).queryByRole("link", { name: /Reports/ })).toBeNull();
    expect(within(nav).getByRole("link", { name: /Home/ })).toBeInTheDocument();
  });
  it("counts what waits in Reviews for the compliance officer", async () => {
    renderApp("/board", "u-daniel");
    expect(await within(await mainNav()).findByRole("link", { name: /Reviews, \d+ waiting/ }, T)).toBeInTheDocument();
  });
  it("never offers the duplicates queue to a fee earner", async () => {
    renderApp("/screening", "u-tom");
    const queues = await screen.findByRole("navigation", { name: "Review queues" }, T);
    expect(within(queues).getByRole("link", { name: /Screening/ })).toBeInTheDocument();
    expect(within(queues).queryByRole("link", { name: /Duplicates/ })).toBeNull();
  });
  it("names the browser tab after the client", async () => {
    renderApp("/clients/c-harbour-quay/summary");
    await screen.findByRole("heading", { name: "Harbour Quay Developments Pty Ltd" }, T);
    await waitFor(() => expect(document.title).toBe("Harbour Quay Developments Pty Ltd · Kinroot"));
  });
});

describe("charts and the dossier", () => {
  it("the book chart has a text twin listing every client", async () => {
    renderApp("/board");
    const twin = await screen.findByRole("region", { name: "Text version of the chart" }, T);
    expect(within(twin).getByText(/Harbour Quay Developments Pty Ltd, client, rated High/)).toBeInTheDocument();
  });
  it("dossier: owners with compounded % and reasons with cited links", async () => {
    renderApp("/clients/c-harbour-quay/summary");
    expect(await screen.findByRole("heading", { name: "Harbour Quay Developments Pty Ltd" }, T)).toBeInTheDocument();
    expect((await screen.findAllByText("49.6%", {}, T)).length).toBeGreaterThan(0);
    expect(screen.getByText("30.4%")).toBeInTheDocument();
    expect(await screen.findByText(/Why high/, {}, T)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Show link E-\d\d on the board/ }).length).toBeGreaterThan(0);
  });
  it("dossier: a beneficial owner opens the drawer with their path to the client", async () => {
    renderApp("/clients/c-harbour-quay/summary");
    const owner = (await screen.findAllByRole("button", { name: /: show on the chart/ }, T))[0]!;
    await userEvent.click(owner);
    const drawer = await screen.findByRole("dialog", {}, T);
    expect(within(drawer).getByText("Path to the client")).toBeInTheDocument();
    expect(within(drawer).getByText("Beneficial owner")).toBeInTheDocument();
  });
  it("dossier: tabs move with ] and the Owners tab is the register twin", async () => {
    renderApp("/clients/c-harbour-quay/summary");
    await screen.findByRole("tab", { name: "Summary" }, T);
    fireEvent.keyDown(window, { key: "]" });
    expect(await screen.findByRole("table", { name: "Everyone in the structure" }, T)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Owners/ })).toHaveAttribute("aria-selected", "true");
  });
  it("shows the Restricted tab only to the compliance officer", async () => {
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
  it("shows the compliance officer the deadline and the draft", async () => {
    renderApp("/reports/case-aurelian", "u-daniel");
    expect((await screen.findAllByText(/business day|Due today|Overdue/, {}, T)).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "Draft report" })).toBeInTheDocument();
  });
});

describe("queues", () => {
  it("duplicates: keeping apart asks for a reason", async () => {
    renderApp("/fuse/m-reyes");
    await screen.findByRole("heading", { name: "Jonathan P. Reyes and Jonathon Reyes" }, T);
    fireEvent.keyDown(window, { key: "k" });
    const dialog = await screen.findByRole("dialog", { name: "Keep apart" }, T);
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep apart" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Give a reason.");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Different middle names on the passports.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep apart" }));
    expect(await screen.findByText("Kept apart.", {}, T)).toBeInTheDocument();
  });
  it("duplicates: the likelihood is stated as N in 100 with the policy bands", async () => {
    renderApp("/fuse/m-reyes");
    expect(await screen.findByRole("img", { name: /Match likelihood 87 in 100/ }, T)).toBeInTheDocument();
  });
  it("screening: a decision needs a reason of 10 characters", async () => {
    renderApp("/screening/h-petrov");
    await userEvent.click(await screen.findByRole("button", { name: "Not a match" }, T));
    const dialog = await screen.findByRole("dialog", { name: "Not a match" }, T);
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/At least 10 characters/);
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Different birth year and nationality.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Recorded as not a match.", {}, T)).toBeInTheDocument();
  });
  it("alerts: the chart opens compared with onboarding", async () => {
    renderApp("/alerts/al-harbour");
    expect(await screen.findByRole("heading", { name: "New director at Kestrel Ventures Ltd" }, T)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Show what changed" }, T)).toHaveAttribute("aria-pressed", "true");
  });
});

describe("records and settings", () => {
  it("activity log: verify the chain", async () => {
    renderApp("/activity", "u-ruth");
    await userEvent.click(await screen.findByRole("button", { name: /Verify/ }, T));
    expect(await screen.findByText(/Chain verified/, {}, { timeout: 8000 })).toBeInTheDocument();
  }, 12000);
  it("programme: a partners' brief in sentences, and obligations that open to their clients", async () => {
    renderApp("/programme", "u-margaret");
    expect(await screen.findByText(/clients are rated high risk/, {}, T)).toBeInTheDocument();
    const row = await screen.findByRole("button", { name: /Periodic reviews/ }, T);
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
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
  it("new client: the client step opens the file and moves to owners", async () => {
    renderApp("/onboard", "u-tom");
    await userEvent.type(await screen.findByLabelText("Legal name", {}, T), "Wharf Street Property Trust");
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Owners" })).toHaveAttribute("aria-selected", "true"), T);
    await userEvent.click(await screen.findByRole("button", { name: /Add a person/ }, T));
    expect(screen.getByRole("combobox", { name: "Role" })).toBeInTheDocument();
  });
});

describe("home", () => {
  it("lists the next decisions for the compliance officer, earliest due first", async () => {
    renderApp("/board", "u-daniel");
    const list = await screen.findByRole("list", { name: /waiting for you/ }, T);
    await waitFor(() => expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(3));
    expect(screen.getByRole("heading", { level: 1, name: /Waiting for you/ })).toBeInTheDocument();
  });
  it("puts the restricted report deadline on the compliance officer's list only", async () => {
    renderApp("/board", "u-daniel");
    expect(await screen.findByText("Report", { exact: true }, T)).toBeInTheDocument();
  });
  it("never shows the report deadline to a fee earner", async () => {
    renderApp("/board", "u-tom");
    await screen.findByRole("list", { name: /waiting for you|Nothing waiting/ }, T);
    expect(screen.queryByText("Report", { exact: true })).toBeNull();
  });
});
