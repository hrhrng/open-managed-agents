import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { createPiToolAssembly } from "../src/harness/assembly/adapters/pi";

describe("Pi assembly skill mounts", () => {
  it("uses progressive skill section instead of inlined bodies", () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const events: never[] = [];
    const runtime = {
      history: { getEvents: () => events, getMessages: () => [], append: vi.fn() },
      sandbox: {},
      broadcast: vi.fn(),
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

    const ctx = {
      agent: {
        id: "agent-test",
        model: faux.getModel().id,
        metadata: { skill_mount: "progressive" },
      },
      userMessage: { type: "user.message", content: [{ type: "text", text: "hi" }] },
      session_id: "session-test",
      tools: {
        read: {
          description: "Read",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "ok",
        },
      },
      model: {} as HarnessContext["model"],
      pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
      systemPrompt: "Base agent prompt.",
      skillMounts: [{
        skillId: "skill_demo",
        name: "Demo Skill",
        description: "A demo",
        mountRoot: "/workspace/.openma/skills/skill_demo/latest/",
        body: "SECRET_SKILL_BODY",
        source: "custom",
      }],
      env: {},
      runtime,
    } as unknown as HarnessContext;

    const assembly = createPiToolAssembly(ctx);
    expect(assembly.systemPrompt).toContain("<available-skills>");
    expect(assembly.systemPrompt).not.toContain("SECRET_SKILL_BODY");
    expect(assembly.systemPrompt).toContain("Base agent prompt.");
  });
});
