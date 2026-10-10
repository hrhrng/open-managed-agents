/**
 * Shared HTTP helpers for harness tools (web_fetch, web_search, …).
 *
 * - Timed fetches with merged caller abortSignal.
 * - Manual redirect following with per-hop environment `allowed_hosts` checks.
 */

/** Environment networking fields used by agent tool HTTP egress. */
export interface ToolEgressNetworking {
  type?: "unrestricted" | "limited" | string;
  allowed_hosts?: string[];
}

export class ToolEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolEgressError";
  }
}

function normalizeHostname(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

function isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
  const host = normalizeHostname(hostname);
  return allowedHosts.some((allowed) => {
    const a = normalizeHostname(allowed);
    return host === a || host.endsWith(`.${a}`);
  });
}

function assertHttpProtocol(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolEgressError(`URL protocol "${url.protocol}" is not allowed (only http/https)`);
  }
}

/**
 * Validate a URL against environment networking policy (limited `allowed_hosts` only).
 */
export function assertToolEgressAllowed(
  urlInput: string | URL,
  networking?: ToolEgressNetworking | null,
): URL {
  let url: URL;
  try {
    url = typeof urlInput === "string" ? new URL(urlInput) : new URL(urlInput.toString());
  } catch {
    throw new ToolEgressError("Invalid URL");
  }

  assertHttpProtocol(url);

  if (networking?.type === "limited") {
    const allowed = networking.allowed_hosts ?? [];
    const hostname = url.hostname;
    if (!isAllowedHost(hostname, allowed)) {
      throw new ToolEgressError(
        `Host "${hostname}" is not allowed. Allowed hosts: ${allowed.join(", ") || "(none)"}`,
      );
    }
  }

  return url;
}

export function mergeAbortSignals(
  signals: (AbortSignal | null | undefined)[],
): AbortSignal | undefined {
  const active = signals.filter((s): s is AbortSignal => s != null);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(active);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const sig of active) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

export interface ToolEgressFetchOptions {
  networking?: ToolEgressNetworking | null;
  timeoutMs?: number;
  abortSignal?: AbortSignal | null;
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 10;

/**
 * Fetch with per-hop allowed_hosts validation (limited networking), manual redirects,
 * timeout, and merged caller abortSignal.
 */
export async function toolEgressFetch(
  input: string | URL,
  init: RequestInit = {},
  options: ToolEgressFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = mergeAbortSignals([init.signal, options.abortSignal, timeoutSignal]);

  let currentUrl = typeof input === "string" ? input : input.toString();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = assertToolEgressAllowed(currentUrl, options.networking);

    const response = await fetch(url.toString(), {
      ...init,
      redirect: "manual",
      signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return response;
      }
      currentUrl = new URL(location, url).toString();
      continue;
    }

    return response;
  }

  throw new ToolEgressError(`Too many redirects (max ${maxRedirects})`);
}

/** Map fetch/abort failures to LLM-readable tool errors. */
export function toolEgressErrorMessage(err: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): string {
  if (err instanceof ToolEgressError) return err.message;
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `Request timed out after ${timeoutMs}ms`;
    }
    return err.message;
  }
  return String(err);
}
