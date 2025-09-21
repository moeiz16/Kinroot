// Thin typed HTTP client for /api/v1: cookie session + CSRF echo, RFC 7807 errors.
// The transport is plain `fetch`; in mock mode (VITE_API_MOCK=1, and in tests) a fixture adapter is
// injected as the fetch implementation so every call still goes through this exact code path.
import type { Problem } from "./types";

export const API_BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem;
  readonly retryAfter: number | null;
  constructor(problem: Problem, retryAfter: number | null = null) {
    super(problem.detail || problem.title);
    this.name = "ApiError";
    this.status = problem.status;
    this.code = problem.code;
    this.problem = problem;
    this.retryAfter = retryAfter;
  }
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) out[e.field] = e.message;
    return out;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);
let onUnauthenticated: ((code: string) => void) | null = null;

export function setFetch(fn: FetchLike): void {
  fetchImpl = fn;
}
export function setUnauthenticatedHandler(fn: ((code: string) => void) | null): void {
  onUnauthenticated = fn;
}

export function readCookie(name: string, source: string = typeof document === "undefined" ? "" : document.cookie): string | null {
  for (const part of source.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function buildQuery(query?: Record<string, string | number | boolean | null | undefined>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

let csrfPromise: Promise<void> | null = null;
async function ensureCsrf(): Promise<string> {
  let token = readCookie("kr_csrf");
  if (token) return token;
  csrfPromise ??= fetchImpl(`${API_BASE}/auth/csrf`, { credentials: "same-origin" }).then(() => undefined);
  await csrfPromise;
  csrfPromise = null;
  token = readCookie("kr_csrf");
  return token ?? "";
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (UNSAFE.has(method)) headers["X-CSRFToken"] = await ensureCsrf();

  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${path}${buildQuery(opts.query)}`, {
      method,
      headers,
      body,
      credentials: "same-origin",
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError({
      type: "about:blank",
      title: "Kinroot can't be reached",
      status: 0,
      code: "network_error",
      detail: "Kinroot can't be reached right now. Check your connection and try again.",
    });
  }

  if (res.status === 204) return undefined as T;
  const type = res.headers.get("Content-Type") ?? "";
  const isJson = type.includes("json");
  if (!res.ok) {
    let problem: Problem;
    if (isJson) problem = (await res.json()) as Problem;
    else problem = { type: "about:blank", title: res.statusText || "Request failed", status: res.status, code: "internal_error" };
    if (!problem.code) problem.code = "internal_error";
    const retry = res.headers.get("Retry-After");
    const error = new ApiError(problem, retry ? Number(retry) : null);
    if (res.status === 401 && onUnauthenticated) onUnauthenticated(problem.code);
    throw error;
  }
  if (!isJson) return (await res.text()) as unknown as T;
  return (await res.json()) as T;
}

export const http = {
  get: <T>(path: string, query?: RequestOptions["query"], signal?: AbortSignal) => request<T>("GET", path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, { body }),
  upload: <T>(path: string, form: FormData) => request<T>("POST", path, { form }),
};

/** Human copy for an API failure. Never reveals whether a restricted record exists. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "not_found":
      case "forbidden":
        return "This page isn't available to you.";
      case "rate_limited":
        return err.retryAfter
          ? `Too many attempts. Try again in ${Math.ceil(err.retryAfter / 60)} minute${err.retryAfter > 60 ? "s" : ""}.`
          : "Too many attempts. Try again shortly.";
      case "action_held":
        return "This step needs the compliance officer's go-ahead.";
      case "client_blocked":
        return "Work on this client is paused while a confirmed sanctions match is handled.";
      case "invalid_credentials":
        return "That email and password don't match.";
      case "session_expired":
        return "Your session ended. Sign in again to carry on.";
      case "already_decided":
        return "Someone has already decided this one. The list has been refreshed.";
      default:
        return err.problem.detail || err.problem.title;
    }
  }
  return "Something went wrong. Try again.";
}
