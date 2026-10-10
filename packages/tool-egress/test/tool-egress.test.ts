import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertToolEgressAllowed,
  toolEgressFetch,
  ToolEgressError,
} from "../src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertToolEgressAllowed", () => {
  it("enforces allowed_hosts in limited mode", () => {
    expect(() =>
      assertToolEgressAllowed("https://evil.com/", {
        type: "limited",
        allowed_hosts: ["safe.com"],
      }),
    ).toThrow(/not allowed/);
    expect(
      assertToolEgressAllowed("https://api.safe.com/", {
        type: "limited",
        allowed_hosts: ["safe.com"],
      }),
    ).toBeInstanceOf(URL);
  });

  it("allows any host when networking is unrestricted", () => {
    expect(
      assertToolEgressAllowed("http://127.0.0.1/", { type: "unrestricted" }),
    ).toBeInstanceOf(URL);
  });
});

describe("toolEgressFetch", () => {
  it("rejects redirect to disallowed host in limited mode", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows redirect when target host is allowed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://other.safe.com/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await toolEgressFetch(
      "https://safe.com/start",
      {},
      {
        networking: { type: "limited", allowed_hosts: ["safe.com"] },
        timeoutMs: 5000,
      },
    );
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
    await expect(
      toolEgressFetch("https://example.com/slow", {}, { timeoutMs: 50 }),
    ).rejects.toSatisfy((err: Error) => err.name === "TimeoutError" || err.name === "AbortError");
  });
});
