import { describe, expect, it } from "vitest";
import type { Agent } from "../src/domain/agent";
import type { Environment } from "../src/domain/environment";
import { SessionsApplicationService } from "../src/index";
import { MemorySessionStore } from "../../session-store-memory/src/index";

const agent: Agent = {
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "claude-sonnet-4-6" },
  multiagent: null,
  name: "Agent",
  skills: [],
  system: null,
  tools: [],
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Local",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

describe("SessionsApplicationService metadata list filter", () => {
  it("round-trips metadata through create and get, and lists only the matching session", async () => {
    const store = new MemorySessionStore();
    let now = new Date("2026-08-26T00:00:00.000Z");
    const ids = ["session_match", "session_other", "session_plain"];
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: {
        find: async () => structuredClone(environment),
      },
      resources: {
        resolve: async () => ({ type: "resolved", resources: [], secrets: [] }),
      },
      lifecycle: {
        sessionStarted: async () => {},
        sessionStopped: async () => {},
      },
      clock: { now: () => now },
      ids: { nextSessionId: () => ids.shift() ?? "session_extra" },
    });

    const created = await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: environment.id,
      metadata: { project_id: "proj_a", creation_key: "ck_1" },
      title: "Match",
    });
    now = new Date("2026-08-26T01:00:00.000Z");
    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: environment.id,
      metadata: { project_id: "proj_b", creation_key: "ck_1" },
      title: "Other",
    });
    now = new Date("2026-08-26T02:00:00.000Z");
    await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: environment.id,
      title: "\"project_id\":\"proj_a\"",
    });

    expect(created).toMatchObject({
      type: "created",
      session: {
        id: "session_match",
        metadata: { project_id: "proj_a", creation_key: "ck_1" },
      },
    });
    const retrieved = await service.retrieveSession({ sessionId: "session_match" });
    expect(retrieved).toMatchObject({
      type: "found",
      session: { metadata: { project_id: "proj_a", creation_key: "ck_1" } },
    });

    const matched = await service.listSessions({
      metadata: { key: "project_id", value: "proj_a" },
    });
    expect(matched).toMatchObject({
      type: "page",
      page: { sessions: [{ id: "session_match" }] },
    });

    const sameCreationKey = await service.listSessions({
      metadata: { key: "creation_key", value: "ck_1" },
      order: "asc",
    });
    expect(sameCreationKey).toMatchObject({
      type: "page",
      page: {
        sessions: [{ id: "session_match" }, { id: "session_other" }],
      },
    });

    const running = await service.listSessions({
      statuses: ["running"],
      order: "asc",
    });
    expect(running).toMatchObject({
      type: "page",
      page: {
        sessions: [
          { id: "session_match" },
          { id: "session_other" },
          { id: "session_plain" },
        ],
      },
    });

    const runningMatch = await service.listSessions({
      statuses: ["running"],
      metadata: { key: "project_id", value: "proj_a" },
    });
    expect(runningMatch).toMatchObject({
      type: "page",
      page: { sessions: [{ id: "session_match" }] },
    });

    expect(await service.listSessions({ statuses: ["idle"] })).toMatchObject({
      type: "page",
      page: { sessions: [] },
    });

    await service.archiveSession({ sessionId: "session_other" });
    const visible = await service.listSessions({ order: "asc" });
    expect(visible).toMatchObject({
      type: "page",
      page: {
        sessions: [{ id: "session_match" }, { id: "session_plain" }],
      },
    });
    const includingArchived = await service.listSessions({
      includeArchived: true,
      order: "asc",
    });
    expect(includingArchived).toMatchObject({
      type: "page",
      page: {
        sessions: [
          { id: "session_match" },
          { id: "session_other" },
          { id: "session_plain" },
        ],
      },
    });
  });
});
