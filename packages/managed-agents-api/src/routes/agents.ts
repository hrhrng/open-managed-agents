import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortResolver,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  agentCreateBodySchema,
  agentListQuerySchema,
  agentPageResponseSchema,
  agentResponseSchema,
  agentRetrieveQuerySchema,
  agentUpdateBodySchema,
  agentVersionListQuerySchema,
} from "../contracts/agents";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toAgentResponse,
  toCreateAgentCommand,
  toListAgentsQuery,
  toListAgentVersionsQuery,
  toUpdateAgentCommand,
} from "../mappers/agents";
import type { AgentView, AgentsApplicationPort, ListAgentsPage } from "../ports";

export type AgentsApplicationPortResolver =
  ApplicationPortResolver<AgentsApplicationPort>;

export type AgentsApplicationPortSource =
  ApplicationPortSource<AgentsApplicationPort>;

function serializeAgent(agent: AgentView): object | null {
  try {
    const parsed = agentResponseSchema.safeParse(toAgentResponse(agent));
    return parsed.success ? (parsed.data as object) : null;
  } catch {
    return null;
  }
}

function serializeAgentPage(page: ListAgentsPage): object | null {
  try {
    const parsed = agentPageResponseSchema.safeParse({
      data: page.agents.map(toAgentResponse),
      next_page: page.nextCursor,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function buildAgentRoutes(
  source: AgentsApplicationPortSource,
  options?: {
    validateTotalToolLimits?: (
      tenantId: string,
      body: unknown,
    ) => Promise<{ ok: true } | { ok: false; error: any }>;
  },
): Hono {
  const app = new Hono();

  app.use("*", requireBeta(MANAGED_AGENTS_BETA));
  app.get("/", async (c) => {
    const query = agentListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      "created_at[gte]": c.req.query("created_at[gte]"),
      "created_at[lte]": c.req.query("created_at[lte]"),
      include_archived: c.req.query("include_archived"),
    });
    if (!query.success) {
      const issue = query.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).listAgents(
      toListAgentsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const page = serializeAgentPage(result.page);
    if (page === null) {
      return c.json(apiError("Application returned an invalid agent page"), 500);
    }

    return c.json(page, 200);
  });

  app.get("/:agentId", async (c) => {
    const query = agentRetrieveQuerySchema.safeParse({
      version: c.req.query("version"),
    });
    if (!query.success) {
      const issue = query.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).retrieveAgent({
      agentId: c.req.param("agentId"),
      ...query.data,
    });
    if (result.type === "not_found") {
      return c.json(notFound(`Agent ${c.req.param("agentId")} was not found`), 404);
    }
    const agent = serializeAgent(result.agent);
    if (agent === null) {
      return c.json(apiError("Application returned an invalid agent resource"), 500);
    }

    return c.json(agent, 200);
  });

  app.get("/:agentId/versions", async (c) => {
    const query = agentVersionListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
    });
    if (!query.success) {
      const issue = query.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).listAgentVersions(
      toListAgentVersionsQuery(c.req.param("agentId"), query.data),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Agent ${c.req.param("agentId")} was not found`), 404);
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }

    const page = serializeAgentPage(result.page);
    if (page === null) {
      return c.json(apiError("Application returned an invalid agent page"), 500);
    }

    return c.json(page, 200);
  });

  app.post("/:agentId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveAgent({
      agentId: c.req.param("agentId"),
    });
    if (result.type === "not_found") {
      return c.json(notFound(`Agent ${c.req.param("agentId")} was not found`), 404);
    }

    const agent = serializeAgent(result.agent);
    if (agent === null) {
      return c.json(apiError("Application returned an invalid agent resource"), 500);
    }

    return c.json(agent, 200);
  });

  app.post("/:agentId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = agentUpdateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).updateAgent(
      toUpdateAgentCommand(c.req.param("agentId"), parsed.data),
    );
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Agent ${c.req.param("agentId")} was not found`), 404);
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }

    const agent = serializeAgent(result.agent);
    if (agent === null) {
      return c.json(apiError("Application returned an invalid agent resource"), 500);
    }

    return c.json(agent, 200);
  });

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = agentCreateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    if (options?.validateTotalToolLimits) {
      // The context has tenantId on custom variables usually. But `managed-agents-api` might abstract it.
      // Wait, let's grab it the same way other routes do, but wait - there is no `c.var.tenant_id` standard here 
      // instead the `AgentsApplicationPort` does have it inside `resolveApplicationPort`.
      // Let's just pull it out of c.var if it's there. 
      const tenantId = (c.var as any)?.tenant_id ?? "unknown";
      const toolCheck = await options.validateTotalToolLimits(tenantId, parsed.data);
      if (!toolCheck.ok) return c.json(toolCheck.error, 400);
    }

    const result = await resolveApplicationPort(source, c).createAgent(
      toCreateAgentCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }

    const agent = serializeAgent(result.agent);
    if (agent === null) {
      return c.json(apiError("Application returned an invalid agent resource"), 500);
    }

    return c.json(agent, 201);
  });

  return app;
}
