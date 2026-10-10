import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertToolEgressAllowed,
  isBlockedIpAddress,
  setDnsResolveForTests,
  toolEgressFetch,
  ToolEgressError,
} from "../src/index.ts";

afterEach(() => {
  setDnsResolveForTests(null);
  vi.restoreAllMocks();
});

describe("isBlockedIpAddress", () => {
  it("blocks private, loopback, link-local, and metadata IPv4", () => {
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("10.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("192.168.1.1")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
  });

  it("blocks IPv6 loopback and ULA", () => {
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedIpAddress("fe80::1")).toBe(true);
    expect(isBlockedIpAddress("fd12::1")).toBe(true);
  });
});

describe("assertToolEgressAllowed", () => {
  it("rejects private literal addresses by default", async () => {
    await expect(assertToolEgressAllowed("http://127.0.0.1/")).rejects.toThrow(ToolEgressError);
    await expect(assertToolEgressAllowed("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /blocked/i,
    );
  });

  it("allows private addresses when allow_internal_addresses is true", async () => {
    await expect(
      assertToolEgressAllowed("http://127.0.0.1/", { allow_internal_addresses: true }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects DNS resolving to private addresses", async () => {
    setDnsResolveForTests(async () => [{ address: "10.0.0.99", family: 4 }]);
    await expect(assertToolEgressAllowed("https://public.example/")).rejects.toThrow(
      /resolves to blocked/i,
    );
  });

  it("enforces allowed_hosts on every call", async () => {
    await expect(
      assertToolEgressAllowed("https://evil.com/", {
        type: "limited",
        allowed_hosts: ["safe.com"],
      }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      assertToolEgressAllowed("https://api.safe.com/", {
        type: "limited",
        allowed_hosts: ["safe.com"],
      }),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("toolEgressFetch redirects", () => {
  beforeEach(() => {
    setDnsResolveForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  });

  it("rejects redirect to internal host", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      toolEgressFetch("https://example.com/start", {}, { timeoutMs: 5000 }),
    ).rejects.toThrow(/blocked/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects redirect to disallowed host in limited mode", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.com/payload" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      toolEgressFetch(
        "https://safe.com/redirect",
        {},
        { networking: { type: "limited", allowed_hosts: ["safe.com"] }, timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it("follows redirect to public host", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    setDnsResolveForTests(async (host) => {
      if (host === "other.example") return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "93.184.216.34", family: 4 }];
    });

    const res = await toolEgressFetch("https://example.com/start", {}, { timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces timeout errors clearly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new DOMException("Timed out", "TimeoutError")),
            { once: true },
          );
        }),
      ),
    );
    setDnsResolveForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(
      toolEgressFetch("https://example.com/slow", {}, { timeoutMs: 50 }),
    ).rejects.toSatisfy((err: Error) => err.name === "TimeoutError" || err.name === "AbortError");
  });
});
