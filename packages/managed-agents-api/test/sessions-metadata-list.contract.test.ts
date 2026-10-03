import { describe, expect, it } from "vitest";
import { MANAGED_AGENTS_BETA } from "../src/beta";
import { makeSessionsPort, sessionView } from "./session-fixtures";
import { buildSessionsTestApi } from "./test-api";

const beta = { "anthropic-beta": MANAGED_AGENTS_BETA };

describe("Managed Agents API — session metadata equality filter", () => {
  it("maps one metadata key and value and keeps the other list filters", async () => {
    const listCalls: unknown[] = [];
    const port = makeSessionsPort({
      listSessions: async (query) => {
        listCalls.push(query);
        return {
          type: "page",
          page: {
            sessions: [sessionView],
            nextCursor: null,
            previousCursor: null,
          },
        };
      },
    });
    const api = buildSessionsTestApi(port);

    const filtered = await api.fetch(new Request(
      "http://openma.test/v1/sessions?limit=25&agent_id=agent_01&agent_version=3&order=asc&statuses[]=running&statuses[]=idle&deployment_id=deployment_01&metadata_key=project_id&metadata_value=proj_a",
      { headers: beta },
    ));
    expect(filtered.status).toBe(200);
    const unfiltered = await api.fetch(new Request(
      "http://openma.test/v1/sessions?limit=25&agent_id=agent_01&order=asc&statuses[]=running",
      { headers: beta },
    ));
    expect(unfiltered.status).toBe(200);

    expect(listCalls).toEqual([
      {
        pageSize: 25,
        agentId: "agent_01",
        agentVersion: 3,
        deploymentId: "deployment_01",
        metadata: { key: "project_id", value: "proj_a" },
        order: "asc",
        statuses: ["running", "idle"],
      },
      {
        pageSize: 25,
        agentId: "agent_01",
        order: "asc",
        statuses: ["running"],
      },
    ]);
  });

  it("rejects a metadata filter that has only a key or only a value", async () => {
    const port = makeSessionsPort({
      listSessions: async () => {
        throw new Error("list should not run");
      },
    });
    const api = buildSessionsTestApi(port);

    const keyOnly = await api.fetch(new Request(
      "http://openma.test/v1/sessions?metadata_key=project_id",
      { headers: beta },
    ));
    const valueOnly = await api.fetch(new Request(
      "http://openma.test/v1/sessions?metadata_value=proj_a",
      { headers: beta },
    ));

    expect(keyOnly.status).toBe(400);
    expect(valueOnly.status).toBe(400);
    await expect(keyOnly.json()).resolves.toMatchObject({
      error: {
        message: expect.stringContaining(
          "metadata_key and metadata_value must be provided together",
        ),
      },
    });
  });
});
