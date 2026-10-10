// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTools } from "../../apps/agent/src/harness/tools";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";
import type { AgentConfig } from "@open-managed-agents/shared";

function makeAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent_test",
    name: "Test Agent",
    model: "claude-sonnet-4-6",
    system: "You are a test agent.",
    tools: [{ type: "agent_toolset_20260401" }],
    version: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const TOOL_EXEC_OPTS = {
  toolCallId: "tc_test",
  messages: [],
  abortSignal: undefined as any,
};

function mockFetch(body = "<html>ok</html>") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200 })),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web_fetch egress (rescoped #281)", () => {
  it("rejects redirect to disallowed host in limited mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.com/" },
        }),
      ),
    );
    const tools = await buildTools(makeAgentConfig(), new TestSandbox(), {
      environmentConfig: {
        networking: { type: "limited", allowed_hosts: ["example.com"] },
      },
    });
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/redirect" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toMatch(/Error:.*not allowed/i);
  });

  it("fetches public URLs successfully", async () => {
    mockFetch("hello world");
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toContain("hello world");
  });
});

describe("web_search timeouts", () => {
  it("returns timeout error when upstream hangs", async () => {
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
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_search.execute(
      { query: "test query" },
      { ...TOOL_EXEC_OPTS, abortSignal: AbortSignal.timeout(80) },
    );
    expect(result).toMatch(/timed out/i);
  });
});
