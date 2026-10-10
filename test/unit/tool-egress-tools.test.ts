// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTools } from "../../apps/agent/src/harness/tools";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";
import type { AgentConfig } from "@open-managed-agents/shared";
import { setDnsResolveForTests } from "@open-managed-agents/tool-egress";

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

function mockPublicFetch(body = "<html>ok</html>") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200 })),
  );
  setDnsResolveForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
}

afterEach(() => {
  setDnsResolveForTests(null);
  vi.restoreAllMocks();
});

describe("web_fetch egress", () => {
  it("rejects localhost without allow_internal_addresses", async () => {
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_fetch.execute(
      { url: "http://127.0.0.1/admin" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toMatch(/Error:.*blocked/i);
  });

  it("allows localhost when allow_internal_addresses is set", async () => {
    mockPublicFetch();
    const tools = await buildTools(makeAgentConfig(), new TestSandbox(), {
      environmentConfig: {
        networking: { type: "unrestricted", allow_internal_addresses: true },
      },
    });
    const result = await tools.web_fetch.execute(
      { url: "http://127.0.0.1/" },
      TOOL_EXEC_OPTS,
    );
    expect(result).not.toMatch(/^Error:/);
    expect(String(result)).toContain("ok");
  });

  it("rejects redirect to internal address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/" },
        }),
      ),
    );
    setDnsResolveForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/redirect" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toMatch(/Error:.*blocked/i);
  });

  it("fetches public URLs successfully", async () => {
    mockPublicFetch("hello world");
    const tools = await buildTools(makeAgentConfig(), new TestSandbox());
    const result = await tools.web_fetch.execute(
      { url: "https://example.com/" },
      TOOL_EXEC_OPTS,
    );
    expect(result).toContain("hello world");
  });
});
