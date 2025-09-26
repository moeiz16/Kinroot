import { describe, expect, it, vi } from "vitest";
import { ApiError, buildQuery, errorMessage, readCookie, request, setFetch, setUnauthenticatedHandler } from "./client";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json", ...headers } });

describe("api client", () => {
  it("builds query strings and skips empty values", () => {
    expect(buildQuery({ q: "calder", page: 2, empty: "", none: undefined, flag: false })).toBe("?q=calder&page=2&flag=false");
    expect(buildQuery()).toBe("");
  });

  it("reads a cookie by name", () => {
    expect(readCookie("kr_csrf", "a=1; kr_csrf=tok%20en; b=2")).toBe("tok en");
    expect(readCookie("missing", "a=1")).toBeNull();
  });

  it("echoes the CSRF cookie on unsafe methods, fetching it first when absent", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    setFetch(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/csrf")) {
        document.cookie = "kr_csrf=abc; path=/";
        return new Response(null, { status: 204 });
      }
      return json(200, { ok: true });
    });
    await request("POST", "/clients", { body: { name: "X" } });
    expect(calls[0]!.url).toBe("/api/v1/auth/csrf");
    expect((calls[1]!.init!.headers as Record<string, string>)["X-CSRFToken"]).toBe("abc");
    expect(calls[1]!.init!.body).toBe(JSON.stringify({ name: "X" }));
  });

  it("does not send a CSRF header on GET", async () => {
    const seen: RequestInit[] = [];
    setFetch(async (_u, init) => (seen.push(init!), json(200, [])));
    await request("GET", "/clients", { query: { page: 1 } });
    expect((seen[0]!.headers as Record<string, string>)["X-CSRFToken"]).toBeUndefined();
  });

  it("turns problem+json into an ApiError with field errors", async () => {
    setFetch(async () => json(422, { type: "x", title: "Validation failed", status: 422, code: "validation_error", detail: "Bad", errors: [{ field: "pct", message: "Too big" }] }));
    const err = (await request("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("validation_error");
    expect(err.fieldErrors()).toEqual({ pct: "Too big" });
  });

  it("returns undefined for 204", async () => {
    setFetch(async () => new Response(null, { status: 204 }));
    await expect(request("GET", "/x")).resolves.toBeUndefined();
  });

  it("calls the unauthenticated handler on 401", async () => {
    const h = vi.fn();
    setUnauthenticatedHandler(h);
    setFetch(async () => json(401, { title: "x", status: 401, code: "session_expired" }));
    await request("GET", "/x").catch(() => undefined);
    expect(h).toHaveBeenCalledWith("session_expired");
    setUnauthenticatedHandler(null);
  });

  it("reports network failures in plain words", async () => {
    setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = (await request("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("network_error");
    expect(errorMessage(err)).toMatch(/can't be reached/);
  });

  it("never reveals whether a restricted record exists", () => {
    const nf = new ApiError({ type: "", title: "", status: 404, code: "not_found" });
    const fb = new ApiError({ type: "", title: "", status: 403, code: "forbidden" });
    expect(errorMessage(nf)).toBe(errorMessage(fb));
    expect(errorMessage(new ApiError({ type: "", title: "", status: 409, code: "action_held" }))).toBe("This step needs the compliance officer's go-ahead.");
  });

  it("keeps the retry time for rate limits", async () => {
    setFetch(async () => json(429, { title: "x", status: 429, code: "rate_limited" }, { "Retry-After": "900" }));
    const err = (await request("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfter).toBe(900);
    expect(errorMessage(err)).toMatch(/15 minutes/);
  });
});
