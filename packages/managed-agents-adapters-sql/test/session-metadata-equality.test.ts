import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { Session } from "@open-managed-agents/managed-agents-application";
import { SqlSessionStore } from "@open-managed-agents/session-store-sql";

const SCHEMA_SQL = `
CREATE TABLE managed_sessions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  agent_version integer NOT NULL,
  environment_id text NOT NULL,
  deployment_id text,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
`;

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
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt,
    environmentId: "env_01",
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

async function storeWith(rows: Array<{ workspaceId: string; session: Session }>) {
  const client = await createBetterSqlite3SqlClient(":memory:");
  await client.exec(SCHEMA_SQL);
  const store = new SqlSessionStore(client, {
    seal: async (value: string) => value,
  });
  for (const row of rows) {
    await store.insert({
      workspaceId: row.workspaceId,
      session: row.session,
      initialEvents: [],
      resourceSecrets: [],
    });
  }
  return store;
}

describe("SqlSessionStore metadata equality", () => {
  it("round-trips metadata and filters one key without changing the other list filters", async () => {
    const match = session("session_match", "2026-08-26T00:00:00.000Z", {
      deploymentId: "deployment_01",
      metadata: {
        project_id: "proj_a",
        creation_key: "ck_1",
        "creation\"key": "a\"b",
      },
      status: "idle",
      title: "project_id",
    });
    const store = await storeWith([
      { workspaceId: "workspace_01", session: match },
      {
        workspaceId: "workspace_01",
        session: session("session_other", "2026-08-26T01:00:00.000Z", {
          metadata: { project_id: "proj_b", creation_key: "ck_1" },
          status: "idle",
        }),
      },
      {
        workspaceId: "workspace_01",
        session: session("session_plain", "2026-08-26T02:00:00.000Z", {
          metadata: {},
          status: "running",
          title: "\"project_id\":\"proj_a\"",
        }),
      },
      {
        workspaceId: "workspace_02",
        session: session("session_foreign", "2026-08-26T03:00:00.000Z", {
          metadata: { project_id: "proj_a" },
          status: "idle",
        }),
      },
    ]);

    expect(await store.findCurrent({
      workspaceId: "workspace_01",
      sessionId: "session_match",
    })).toMatchObject({
      revision: 1,
      session: { metadata: match.metadata },
    });

    const matched = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "project_id", value: "proj_a" },
    });
    expect(matched.map((record) => record.session.id)).toEqual(["session_match"]);

    const quotedKey = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "creation\"key", value: "a\"b" },
    });
    expect(quotedKey.map((record) => record.session.id)).toEqual(["session_match"]);

    const prefix = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "project", value: "proj_a" },
    });
    expect(prefix).toEqual([]);

    const valuePrefix = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "project_id", value: "proj" },
    });
    expect(valuePrefix).toEqual([]);

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

    const deployment = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      deploymentId: "deployment_01",
    });
    expect(deployment.map((record) => record.session.id)).toEqual(["session_match"]);

    const combined = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      statuses: ["idle"],
      deploymentId: "deployment_01",
      metadata: { key: "creation_key", value: "ck_1" },
    });
    expect(combined.map((record) => record.session.id)).toEqual(["session_match"]);

    const replaced = await store.replaceCurrent({
      workspaceId: "workspace_01",
      sessionId: "session_match",
      expectedRevision: 1,
      next: session("session_match", "2026-08-26T00:00:00.000Z", {
        deploymentId: "deployment_01",
        metadata: { project_id: "proj_renamed" },
        status: "idle",
      }),
    });
    expect(replaced.type).toBe("replaced");
    const afterRename = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "project_id", value: "proj_renamed" },
    });
    expect(afterRename.map((record) => record.session.id)).toEqual(["session_match"]);
    const stale = await store.listCurrent({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      order: "asc",
      metadata: { key: "project_id", value: "proj_a" },
    });
    expect(stale).toEqual([]);
  });
});
