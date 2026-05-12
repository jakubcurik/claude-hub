import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  TelemetryComparison,
  TelemetryFilters,
  TelemetryIngestRequest
} from "@claude-hub/schema";
import type { RegistryRepository, HubUser } from "./repository.js";
import { TelemetryRepository } from "./telemetry-repository.js";

const MAX_RANGE_DAYS = 365;

interface RouteContext {
  repository: RegistryRepository;
  telemetry: TelemetryRepository;
}

export async function registerTelemetryRoutes(app: FastifyInstance, ctx: RouteContext) {
  const { repository, telemetry } = ctx;

  // ─────────── Ingest (auth = pairing token od daemonu) ───────────

  app.post<{ Body: TelemetryIngestRequest }>(
    "/v1/telemetry/ingest",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["items"],
          properties: {
            items: {
              type: "array",
              maxItems: 2000,
              items: {
                type: "object",
                required: ["kind"],
                properties: {
                  kind: { type: "string", enum: ["metric", "event"] },
                  metric: { type: "object" },
                  event: { type: "object" }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      const device = await repository.resolveDeviceByPairingToken(token);
      if (!device) {
        return sendError(reply, 401, "unauthorized", "Neznámý párovací token.");
      }
      const result = await telemetry.ingest(device.userId, device.tokenHash, request.body.items);
      return reply.code(202).send(result);
    }
  );

  // ─────────── Analytics — viditelné všem členům týmu ───────────

  app.get<{ Querystring: TelemetryFilters }>(
    "/v1/analytics/overview",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            projectPath: { type: "string" },
            userId: { type: "string" }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await repository.getMembership(repository.teamId, user.id);
      if (!membership) {
        return sendError(reply, 403, "forbidden", "Nemáte přístup k tomuto týmu.");
      }
      const filters = clampFilters(request.query);
      const overview = await telemetry.getOverview(repository.teamId, filters);
      return overview;
    }
  );

  app.get<{
    Querystring: {
      aFrom: string;
      aTo: string;
      bFrom: string;
      bTo: string;
      projectPath?: string;
      userId?: string;
    };
  }>(
    "/v1/analytics/compare",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["aFrom", "aTo", "bFrom", "bTo"],
          properties: {
            aFrom: { type: "string", format: "date-time" },
            aTo: { type: "string", format: "date-time" },
            bFrom: { type: "string", format: "date-time" },
            bTo: { type: "string", format: "date-time" },
            projectPath: { type: "string" },
            userId: { type: "string" }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await repository.getMembership(repository.teamId, user.id);
      if (!membership) {
        return sendError(reply, 403, "forbidden", "Nemáte přístup k tomuto týmu.");
      }
      const filtersA = clampFilters({
        from: request.query.aFrom,
        to: request.query.aTo,
        projectPath: request.query.projectPath,
        userId: request.query.userId
      });
      const filtersB = clampFilters({
        from: request.query.bFrom,
        to: request.query.bTo,
        projectPath: request.query.projectPath,
        userId: request.query.userId
      });
      const [periodA, periodB] = await Promise.all([
        telemetry.getOverview(repository.teamId, filtersA),
        telemetry.getOverview(repository.teamId, filtersB)
      ]);
      const comparison: TelemetryComparison = {
        periodA,
        periodB,
        delta: {
          sessionsPct: deltaPct(periodA.totals.sessions, periodB.totals.sessions),
          tokensPct: deltaPct(
            periodA.totals.tokensInput + periodA.totals.tokensOutput,
            periodB.totals.tokensInput + periodB.totals.tokensOutput
          ),
          costUsdPct: deltaPct(periodA.totals.costUsd, periodB.totals.costUsd),
          activeSecondsPct: deltaPct(periodA.totals.activeSeconds, periodB.totals.activeSeconds)
        }
      };
      return comparison;
    }
  );

  app.get("/v1/analytics/projects", async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    const membership = await repository.getMembership(repository.teamId, user.id);
    if (!membership) {
      return sendError(reply, 403, "forbidden", "Nemáte přístup k tomuto týmu.");
    }
    return { projects: await telemetry.getProjectsList(repository.teamId) };
  });

  // ─────────── Settings (jen owner) ───────────

  app.get("/v1/analytics/settings", async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    const membership = await repository.getMembership(repository.teamId, user.id);
    if (!membership) {
      return sendError(reply, 403, "forbidden", "Nemáte přístup k tomuto týmu.");
    }
    return { users: await telemetry.listUserSettings(repository.teamId) };
  });

  app.put<{ Params: { userId: string }; Body: { disabled: boolean } }>(
    "/v1/analytics/settings/:userId",
    {
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          properties: { userId: { type: "string", minLength: 1 } }
        },
        body: {
          type: "object",
          required: ["disabled"],
          properties: { disabled: { type: "boolean" } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await repository.getMembership(repository.teamId, user.id);
      if (!membership || membership.role !== "owner") {
        return sendError(reply, 403, "forbidden", "Tuto akci může provést jen vlastník týmu.");
      }
      const target = await repository.getMembership(repository.teamId, request.params.userId);
      if (!target) {
        return sendError(reply, 404, "not_found", "Cílový uživatel není členem týmu.");
      }
      await telemetry.setOwnerDisabled(request.params.userId, request.body.disabled);
      return { ok: true };
    }
  );
}

function clampFilters(input: Partial<TelemetryFilters>): TelemetryFilters {
  const now = new Date();
  const minFrom = new Date(now.getTime() - MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
  const rawFrom = input.from ? new Date(input.from) : minFrom;
  const rawTo = input.to ? new Date(input.to) : now;
  const from = Number.isFinite(rawFrom.getTime()) ? rawFrom : minFrom;
  const to = Number.isFinite(rawTo.getTime()) ? rawTo : now;
  const clampedFrom = from < minFrom ? minFrom : from;
  const clampedTo = to > now ? now : to;
  return {
    from: clampedFrom.toISOString(),
    to: clampedTo.toISOString(),
    projectPath: input.projectPath || undefined,
    userId: input.userId || undefined
  };
}

function deltaPct(a: number, b: number): number {
  if (b === 0) {
    return a === 0 ? 0 : 100;
  }
  return ((a - b) / b) * 100;
}

async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: RegistryRepository
): Promise<HubUser | null> {
  const user = await repository.getSession(bearerToken(request.headers.authorization));
  if (!user) {
    sendError(reply, 401, "unauthorized", "Nejdřív se přihlaste do Claude Hubu.");
    return null;
  }
  return user;
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization) return "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : "";
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: defaultErrorTitle(status), code, message });
}

function defaultErrorTitle(status: number) {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 429:
      return "Too Many Requests";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}
