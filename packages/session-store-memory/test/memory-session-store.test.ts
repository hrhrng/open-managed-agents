import { describe, expect, it } from "vitest";
import type { Session } from "@open-managed-agents/domain/sessions";
import { MemorySessionStore } from "../src/index";

function session(
  id: string,
  createdAt: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    agent: {
      id: "agent_01",
      description: null,
      mcpServers: [],
      model: { id: "claude-sonnet-4-6" },
      multiagent: null,
      name: "Agent",
      skills: [],
      system: null,
      tools: [],
      version: 3,
    },
    archivedAt: null,
    budget: null,
    createdAt,
    environmentId: "environment_01",
    metadata: {},
    outcomeEvaluations: [],
    resources: [],
    stats: {},
    status: "running",
    title: null,
    updatedAt: createdAt,
    usage: {},
    vaultIds: [],
    ...overrides,
  };
}

async function insert(
  store: MemorySessionStore,
  workspaceId: string,
  value: Session,
) {
  return store.insert({
    workspaceId,
    session: value,
    initialEvents: [],
    resourceSecrets: [],
  });
}

describe("MemorySessionStore", () => {
  it("isolates workspaces, clones records, and enforces optimistic revisions", async () => {
    const store = new MemorySessionStore();
    const original = session("session_01", "2026-08-26T00:00:00.000Z");
    const inserted = await insert(store, "workspace_a", original);
    original.title = "mutated outside";
    inserted.session.title = "mutated result";

    expect(await store.findCurrent({
      workspaceId: "workspace_b",
      sessionId: original.id,
    })).toBeNull();
    expect(await store.findCurrent({
      workspaceId: "workspace_a",
      sessionId: original.id,
    })).toMatchObject({ revision: 1, session: { title: null } });

    expect(await store.replaceCurrent({
      workspaceId: "workspace_a",
      sessionId: original.id,
      expectedRevision: 9,
      next: session(original.id, original.createdAt, { title: "new" }),
    })).toEqual({ type: "revision_conflict", actualRevision: 1 });
    expect(await store.replaceCurrent({
      workspaceId: "workspace_a",
      sessionId: original.id,
      expectedRevision: 1,
      next: session(original.id, original.createdAt, { title: "new" }),
    })).toMatchObject({
      type: "replaced",
      record: { revision: 2, session: { title: "new" } },
    });
  });

  it("filters and paginates in the same stable order as persistent stores", async () => {
    const store = new MemorySessionStore();
    await insert(store, "workspace_01", session(
      "session_01",
      "2026-08-26T00:00:00.000Z",
      { deploymentId: "deployment_01", status: "idle" },
    ));
    await insert(store, "workspace_01", session(
      "session_02",
      "2026-08-26T01:00:00.000Z",
      { status: "running" },
    ));
    await insert(store, "workspace_01", session(
      "session_03",
      "2026-08-26T02:00:00.000Z",
      { status: "idle" },
    ));

    const page = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 1,
      includeArchived: false,
      order: "desc",
      statuses: ["idle"],
      position: {
        createdAt: "2026-08-26T02:00:00.000Z",
        sessionId: "session_03",
        direction: "next",
      },
    });
    expect(page.map((record) => record.session.id)).toEqual(["session_01"]);

    const deployment = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      deploymentId: "deployment_01",
    });
    expect(deployment.map((record) => record.session.id)).toEqual(["session_01"]);
  });

  it("matches one metadata entry and leaves the other list filters in place", async () => {
    const store = new MemorySessionStore();
    await insert(store, "workspace_01", session(
      "session_match",
      "2026-08-26T00:00:00.000Z",
      {
        deploymentId: "deployment_01",
        metadata: { project_id: "proj_a", creation_key: "ck_1" },
        status: "idle",
        title: "project_id",
      },
    ));
    await insert(store, "workspace_01", session(
      "session_other",
      "2026-08-26T01:00:00.000Z",
      {
        metadata: { project_id: "proj_b", creation_key: "ck_1" },
        status: "idle",
      },
    ));
    await insert(store, "workspace_01", session(
      "session_plain",
      "2026-08-26T02:00:00.000Z",
      { metadata: {}, status: "running", title: "\"project_id\":\"proj_a\"" },
    ));
    await insert(store, "workspace_02", session(
      "session_foreign",
      "2026-08-26T03:00:00.000Z",
      { metadata: { project_id: "proj_a" }, status: "idle" },
    ));

    const stored = await store.findCurrent({
      workspaceId: "workspace_01",
      sessionId: "session_match",
    });
    expect(stored?.session.metadata).toEqual({
      project_id: "proj_a",
      creation_key: "ck_1",
    });

    const matched = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "project_id", value: "proj_a" },
    });
    expect(matched.map((record) => record.session.id)).toEqual(["session_match"]);

    const prefix = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "project", value: "proj_a" },
    });
    expect(prefix).toEqual([]);

    const idle = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      statuses: ["idle"],
    });
    expect(idle.map((record) => record.session.id)).toEqual([
      "session_match",
      "session_other",
    ]);

    const idleMatch = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      statuses: ["idle"],
      metadata: { key: "creation_key", value: "ck_1" },
      deploymentId: "deployment_01",
    });
    expect(idleMatch.map((record) => record.session.id)).toEqual(["session_match"]);

    const replaced = await store.replaceCurrent({
      workspaceId: "workspace_01",
      sessionId: "session_match",
      expectedRevision: 1,
      next: session("session_match", "2026-08-26T00:00:00.000Z", {
        metadata: { project_id: "proj_renamed" },
        status: "idle",
      }),
    });
    expect(replaced).toMatchObject({ type: "replaced" });
    const renamed = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "project_id", value: "proj_a" },
    });
    expect(renamed).toEqual([]);
    const afterRename = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "project_id", value: "proj_renamed" },
    });
    expect(afterRename.map((record) => record.session.id)).toEqual(["session_match"]);
  });

  it("archives and deletes with explicit results", async () => {
    const store = new MemorySessionStore();
    await insert(store, "workspace_01", session(
      "session_01",
      "2026-08-26T00:00:00.000Z",
    ));

    expect(await store.archiveCurrent({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      archivedAt: "2026-08-26T03:00:00.000Z",
    })).toMatchObject({
      type: "archived",
      record: {
        revision: 2,
        session: {
          archivedAt: "2026-08-26T03:00:00.000Z",
          updatedAt: "2026-08-26T03:00:00.000Z",
        },
      },
    });
    expect(await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
    })).toEqual([]);
    expect(await store.deleteCurrent({
      workspaceId: "workspace_01",
      sessionId: "session_01",
    })).toEqual({ type: "deleted" });
    expect(await store.deleteCurrent({
      workspaceId: "workspace_01",
      sessionId: "session_01",
    })).toEqual({ type: "not_found" });
  });
});
