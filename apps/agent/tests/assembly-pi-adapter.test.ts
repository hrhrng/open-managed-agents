import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createPiToolAssembly } from "../src/harness/assembly/adapters/pi";
import { TOOL_ASSEMBLY_WARNING_SOURCE } from "../src/harness/assembly/loaded-tools-state";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";

const MCP_TOOL = "mcp__github__create_issue";

function makeAssemblyContext(events: SessionEvent[]): HarnessContext {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);

  const runtime = {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    sandbox: {},
    broadcast: (event: SessionEvent) => events.push(event),
    broadcastStreamStart: vi.fn(),
    broadcastChunk: vi.fn(),
    broadcastStreamEnd: vi.fn(),
    broadcastThinkingStart: vi.fn(),
    broadcastThinkingChunk: vi.fn(),
    broadcastThinkingEnd: vi.fn(),
    broadcastToolInputStart: vi.fn(),
    broadcastToolInputChunk: vi.fn(),
    broadcastToolInputEnd: vi.fn(),
    reportUsage: vi.fn(),
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;

  return {
    agent: {
      id: "agent-test",
      model: faux.getModel().id,
      metadata: { tool_search: "on" },
    },
    userMessage: { type: "user.message", content: [{ type: "text", text: "hi" }] },
    session_id: "session-test",
    tools: {
      read: {
        description: "Read",
        inputSchema: z.object({ path: z.string() }),
        execute: async () => "ok",
      },
      [MCP_TOOL]: {
        description: "Create issue",
        inputSchema: z.object({ title: z.string() }),
        execute: async () => ({ ok: true }),
      },
    },
    model: {} as HarnessContext["model"],
    pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
    systemPrompt: "system",
    env: {},
    runtime,
  } as unknown as HarnessContext;
}

describe("createPiToolAssembly", () => {
  it("restores loaded MCP tools from session events on init", () => {
    const events: SessionEvent[] = [
      {
        type: "session.warning",
        source: TOOL_ASSEMBLY_WARNING_SOURCE,
        message: "loaded",
        details: { loadedToolNames: [MCP_TOOL] },
      },
    ];
    const assembly = createPiToolAssembly(makeAssemblyContext(events));
    expect(assembly.initialTools.map((tool) => tool.name)).toContain(MCP_TOOL);
    expect(assembly.getState().loadedToolNames).toContain(MCP_TOOL);
  });

  it("claude_code (default): bootstrap deferred list for first model turn", () => {
    const assembly = createPiToolAssembly(makeAssemblyContext([]));
    expect(assembly.systemPrompt).toBe("system");
    expect(assembly.bootstrapTurnMessages).toHaveLength(1);
    expect(assembly.bootstrapTurnMessages[0]?.content).toContain(MCP_TOOL);
    expect(assembly.bootstrapTurnMessages[0]?.content).toContain("tool_search");
  });

  it("incremental: defers next-turn hint until deferred set changes", async () => {
    const events: SessionEvent[] = [];
    const ctx = makeAssemblyContext(events);
    const MCP_OTHER = "mcp__docs__lookup";
    ctx.tools[MCP_OTHER] = {
      description: "Lookup docs",
      inputSchema: z.object({ query: z.string() }),
      execute: async () => "ok",
    };
    ctx.agent.metadata = { tool_search: "on", tool_search_deferred_hints: "incremental" };
    const assembly = createPiToolAssembly(ctx);
    expect(assembly.systemPrompt).toContain("<deferred-tools>");
    expect(assembly.bootstrapTurnMessages).toHaveLength(0);

    const agent = {} as Agent;
    assembly.attach(agent);
    const unchanged = await agent.prepareNextTurnWithContext!({
      context: { messages: [], tools: assembly.initialTools },
      model: ctx.pi!.model,
      thinkingLevel: "off",
    });
    expect(unchanged?.messages ?? []).toHaveLength(0);

    const search = assembly.initialTools.find((tool) => tool.name === "tool_search");
    await search!.execute!("load-1", { query: `select:${MCP_TOOL}` });
    expect(assembly.getState().loadedToolNames).toContain(MCP_TOOL);

    const changed = await agent.prepareNextTurnWithContext!({
      context: { messages: [], tools: assembly.initialTools },
      model: ctx.pi!.model,
      thinkingLevel: "off",
    });
    expect(changed?.messages?.[0]?.content).toContain("Deferred tools changed");
  });

  it("records newly loaded tools via session.warning when tool_search runs", async () => {
    const events: SessionEvent[] = [];
    const ctx = makeAssemblyContext(events);
    const assembly = createPiToolAssembly(ctx);
    const search = assembly.initialTools.find((tool) => tool.name === "tool_search");
    expect(search?.execute).toBeTypeOf("function");
    await search!.execute!("call-1", { query: `select:${MCP_TOOL}` });
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.warning",
      source: TOOL_ASSEMBLY_WARNING_SOURCE,
      details: { loadedToolNames: [MCP_TOOL] },
    }));
    expect(assembly.getState().loadedToolNames).toContain(MCP_TOOL);
  });
});
