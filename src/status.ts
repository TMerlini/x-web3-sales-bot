// In-memory operational status for the dashboard console.
// Surfaces the two external dependencies that silently block the bot —
// Moralis (sale *detection*) and X (sale *posting*) — plus a rolling event log.

export type Health = "ok" | "down" | "unknown";

interface ApiStatus {
  health: Health;
  code?: number;
  message?: string;
  detail?: string; // e.g. "spend_cap", "rate_limit"
  resetAt?: string; // when the block lifts (X spend-cap reset date, rate-limit reset)
  lastOkAt?: string;
  lastCheckAt?: string;
}

interface BotEvent {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

const moralis: ApiStatus = { health: "unknown" };
const x: ApiStatus = { health: "unknown" };
const events: BotEvent[] = [];
const MAX_EVENTS = 50;
let lastPollAt: string | null = null;

const now = () => new Date().toISOString();

export function logEvent(level: BotEvent["level"], message: string): void {
  events.unshift({ at: now(), level, message });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

export function recordPoll(): void {
  lastPollAt = now();
}

export function recordMoralis(ok: boolean, message?: string): void {
  moralis.health = ok ? "ok" : "down";
  moralis.lastCheckAt = now();
  if (ok) {
    moralis.lastOkAt = now();
    moralis.code = undefined;
    moralis.message = undefined;
    moralis.detail = undefined;
  } else {
    moralis.message = message;
    // crude quota detection from the thrown message ("...failed (401)..." / "consumed")
    moralis.detail = message && /401|consumed|usage|quota/i.test(message) ? "quota" : "error";
    logEvent("error", `Moralis ${moralis.detail === "quota" ? "quota exhausted" : "error"}: ${message ?? "request failed"}`);
  }
}

export interface XError {
  kind: "spend_cap" | "rate_limit" | "auth" | "other";
  code?: number;
  message: string;
  resetAt?: string;
}

/** Classify a twitter-api-v2 error into the operationally meaningful buckets. */
export function classifyTweetError(err: unknown): XError {
  const e = err as { code?: number; message?: string; data?: { title?: string; detail?: string; type?: string; reset_date?: string }; rateLimit?: { reset?: number } };
  const code = e?.code;
  const data = e?.data;
  if (code === 403 && (data?.title === "SpendCapReached" || (data?.type ?? "").includes("credits"))) {
    return { kind: "spend_cap", code, message: data?.detail || "X API monthly spend cap reached", resetAt: data?.reset_date ? String(data.reset_date) : undefined };
  }
  if (code === 429 || e?.rateLimit) {
    const reset = e?.rateLimit?.reset ? new Date(e.rateLimit.reset * 1000).toISOString() : undefined;
    return { kind: "rate_limit", code: code ?? 429, message: "X API rate limit", resetAt: reset };
  }
  if (code === 401) return { kind: "auth", code, message: "X API auth failed — check credentials" };
  return { kind: "other", code, message: e?.message ? String(e.message).slice(0, 200) : "tweet failed" };
}

export function recordTweetOk(): void {
  x.health = "ok";
  x.lastOkAt = now();
  x.lastCheckAt = now();
  x.code = undefined;
  x.message = undefined;
  x.detail = undefined;
  x.resetAt = undefined;
}

export function recordTweetError(xe: XError): void {
  x.health = "down";
  x.lastCheckAt = now();
  x.code = xe.code;
  x.message = xe.message;
  x.detail = xe.kind;
  x.resetAt = xe.resetAt;
  logEvent("warn", `X blocked (${xe.kind}${xe.code ? " " + xe.code : ""})${xe.resetAt ? ` — resets ${xe.resetAt}` : ""}`);
}

export function isXDown(): boolean {
  return x.health === "down";
}

export function getStatusSnapshot() {
  return { moralis, x, lastPollAt, events: events.slice(0, 30) };
}
