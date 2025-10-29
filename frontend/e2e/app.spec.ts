// The calm redesign end to end: one title per screen, the chart as the hero, detail on demand, every role's view.
import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "Kinroot-demo-2025!";
const HARBOUR = "Harbour Quay Developments Pty Ltd";

// The demo clock: move Date to 10 Oct 2025 and leave timers alone, so animations still run.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const Real = Date;
    const offset = new Real("2025-10-10T10:30:00+11:00").getTime() - Real.now();
    class Demo extends Real {
      constructor(...a: ConstructorParameters<typeof Date>) {
        if (a.length === 0) super(Real.now() + offset);
        else super(...a);
      }
      static now() {
        return Real.now() + offset;
      }
    }
    globalThis.Date = Demo as DateConstructor;
  });
});

// Sign in through the form once per person, then reuse the session (sign-in is rate limited, as it should be).
const sessions = new Map<string, Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>>>();
async function signIn(page: Page, email = "daniel@harbourline.example") {
  const saved = sessions.get(email);
  if (saved) {
    await page.context().addCookies(saved);
    await page.goto("/board");
  } else {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(page.getByRole("heading", { level: 1, name: /Waiting for you/ })).toBeVisible();
  sessions.set(email, await page.context().cookies());
}

test("landing: one question, a live sample and one way in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Who really owns your client?");
  await expect(page.locator(".lp-owner")).toContainText("Margaret Calder");
  await page.getByRole("radio", { name: /Trust over a company/ }).click();
  await expect(page.locator(".lp-owner")).toContainText("Grace Liu");
  await page.getByRole("button", { name: /Open the sample firm/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Waiting for you/ })).toBeVisible();
});

test("home: what waits on you beside the client book", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("list", { name: /waiting for you/ }).getByRole("listitem").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "The client book" })).toBeVisible();
  await page.getByRole("radio", { name: "Shared" }).click();
  await expect(page.getByRole("status").filter({ hasText: /share an officer or address/ })).toBeVisible();
});

test("dossier: the chart traces the owner; a click opens the detail", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Clients" }).click();
  await page.getByRole("link", { name: HARBOUR }).click();
  await expect(page.getByRole("heading", { level: 1, name: HARBOUR })).toBeVisible();
  await expect(page.getByRole("button", { name: /Effective share 49.6%/ })).toBeVisible();
  await page.getByRole("button", { name: /Effective share 49.6%/ }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("Path to the client")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: /Owners/ }).click();
  await expect(page.getByRole("table", { name: "Everyone in the structure" })).toBeVisible();
});

test("reviews: a screening decision asks for a reason in a dialog", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Reviews/ }).click();
  await expect(page.getByRole("navigation", { name: "Review queues" })).toBeVisible();
  await page.locator(".items .item").first().click();
  await page.getByRole("button", { name: "Not a match" }).click();
  const dialog = page.getByRole("dialog", { name: "Not a match" });
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/At least 10 characters/);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("duplicates: merging asks first and can be cancelled", async ({ page }) => {
  await signIn(page);
  await page.goto("/fuse");
  await page.locator(".items .item").first().click();
  await page.getByRole("button", { name: "Merge" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Both original records are kept");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Merge" })).toBeVisible();
});

test("roles: a fee earner never sees reports or the duplicates queue", async ({ page }) => {
  await signIn(page, "tom@harbourline.example");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: /Reports/ })).toHaveCount(0);
  await nav.getByRole("link", { name: /Reviews/ }).click();
  await expect(page.getByRole("navigation", { name: "Review queues" }).getByRole("link", { name: /Duplicates/ })).toHaveCount(0);
});

test("account menu: dark mode, activity log and settings", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("menuitem", { name: /Dark mode/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("menuitem", { name: /Activity log/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Activity log/ })).toBeVisible();
});

test("phone: no sideways scrolling, navigation in the menu @phone", async ({ page }) => {
  await signIn(page);
  for (const path of ["/board", "/clients", "/screening", "/programme", "/settings/firm"]) {
    await page.goto(path);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), path).toBe(true);
  }
  await page.getByRole("banner").getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Programme" })).toBeVisible();
});
