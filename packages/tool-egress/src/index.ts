/**
 * Shared egress policy for harness tools (web_fetch, web_search, …).
 *
 * - Blocks private / loopback / link-local / metadata targets by default.
 * - Honors environment `networking.allowed_hosts` on every redirect hop.
 * - Manual redirect following so host + DNS checks cannot be bypassed.
 * - Works in Node and Cloudflare Workers (nodejs_compat → node:dns).
 */

/** Subset of environment networking config used by agent tools. */
export interface ToolEgressNetworking {
  type?: "unrestricted" | "limited" | string;
  allowed_hosts?: string[];
  /**
   * When true, private/link-local/loopback targets are permitted.
   * Default false — self-hosted operators opt in explicitly.
   */
  allow_internal_addresses?: boolean;
}

export class ToolEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolEgressError";
  }
}

export type DnsAddress = { address: string; family: number };

export type DnsResolveFn = (hostname: string) => Promise<DnsAddress[]>;

let dnsResolveOverride: DnsResolveFn | null = null;

/** Test hook — restore with `setDnsResolveForTests(null)`. */
export function setDnsResolveForTests(fn: DnsResolveFn | null): void {
  dnsResolveOverride = fn;
}

async function defaultDnsResolve(hostname: string): Promise<DnsAddress[]> {
  const { lookup } = await import("node:dns/promises");
  const results = await lookup(hostname, { all: true, verbatim: true });
  const list = Array.isArray(results) ? results : [results];
  return list.map((r) => ({ address: r.address, family: r.family }));
}

async function resolveHostAddresses(hostname: string): Promise<DnsAddress[]> {
  const fn = dnsResolveOverride ?? defaultDnsResolve;
  return fn(hostname);
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
]);

const METADATA_IPV4 = "169.254.169.254";

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

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function ipv4ToUint32(octets: number[]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function inRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

/** True when the address must not be reached by default tool egress. */
export function isBlockedIpAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();

  const v4 = parseIpv4(ip);
  if (v4) {
    const n = ipv4ToUint32(v4);
    if (v4[0] === 0) return true; // 0.0.0.0/8
    if (v4[0] === 10) return true; // private
    if (v4[0] === 127) return true; // loopback
    if (v4[0] === 169 && v4[1] === 254) return true; // link-local + metadata
    if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true;
    if (v4[0] === 192 && v4[1] === 168) return true;
    if (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127) return true; // CGNAT
    if (v4[0] === 192 && v4[1] === 0 && v4[2] === 0) return true;
    if (v4[0] === 198 && (v4[1] === 18 || v4[1] === 19)) return true;
    if (n === ipv4ToUint32(parseIpv4(METADATA_IPV4)!)) return true;
    if (v4[0] >= 224) return true; // multicast + reserved
    return false;
  }

  if (ip.includes(":")) {
    if (ip === "::" || ip === "::1") return true;
    if (ip.startsWith("fe80:")) return true; // link-local
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA
    if (ip.startsWith("::ffff:")) {
      const mapped = ip.slice("::ffff:".length);
      if (mapped.includes(".")) return isBlockedIpAddress(mapped);
      return isBlockedIpAddress(mapped); // hex mapped — treat conservatively
    }
    if (ip.startsWith("2001:db8:")) return true;
  }

  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host === METADATA_IPV4) return true;
  return false;
}

function assertHttpProtocol(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolEgressError(`URL protocol "${url.protocol}" is not allowed (only http/https)`);
  }
}

/**
 * Validate a single URL before a tool egress request (sync hostname / literal IP checks
 * plus async DNS when the host is not an IP literal).
 */
export async function assertToolEgressAllowed(
  urlInput: string | URL,
  networking?: ToolEgressNetworking | null,
): Promise<URL> {
  let url: URL;
  try {
    url = typeof urlInput === "string" ? new URL(urlInput) : new URL(urlInput.toString());
  } catch {
    throw new ToolEgressError("Invalid URL");
  }

  assertHttpProtocol(url);

  const allowInternal = networking?.allow_internal_addresses === true;
  const hostname = url.hostname;

  if (networking?.type === "limited") {
    const allowed = networking.allowed_hosts ?? [];
    if (!isAllowedHost(hostname, allowed)) {
      throw new ToolEgressError(
        `Host "${hostname}" is not allowed. Allowed hosts: ${allowed.join(", ") || "(none)"}`,
      );
    }
  }

  if (!allowInternal) {
    if (isBlockedHostname(hostname)) {
      throw new ToolEgressError(`Host "${hostname}" is blocked (internal/metadata address)`);
    }

    const literalV4 = parseIpv4(hostname);
    if (literalV4) {
      if (isBlockedIpAddress(hostname)) {
        throw new ToolEgressError(`Address "${hostname}" is blocked (private or link-local)`);
      }
      return url;
    }

    if (hostname.includes(":")) {
      if (isBlockedIpAddress(hostname)) {
        throw new ToolEgressError(`Address "${hostname}" is blocked (private or link-local)`);
      }
      return url;
    }

    let resolved: DnsAddress[];
    try {
      resolved = await resolveHostAddresses(hostname);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ToolEgressError(`Could not resolve host "${hostname}": ${detail}`);
    }
    if (resolved.length === 0) {
      throw new ToolEgressError(`Could not resolve host "${hostname}"`);
    }
    for (const { address } of resolved) {
      if (isBlockedIpAddress(address)) {
        throw new ToolEgressError(
          `Host "${hostname}" resolves to blocked address ${address}`,
        );
      }
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
 * Fetch with tool egress policy: per-hop validation, manual redirects, timeout,
 * and merged caller abortSignal.
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
    const url = await assertToolEgressAllowed(currentUrl, options.networking);

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
