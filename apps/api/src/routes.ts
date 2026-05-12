import type { FastifyInstance } from "fastify";
import type { CatalogAsset } from "@claude-hub/schema";
import type { RegistryRepository } from "./repository.js";

const assetTypes = ["skill", "command", "mcp", "hook", "plugin", "config"] as const;
const riskLevels = ["low", "medium", "high", "restricted"] as const;

const teamParamsSchema = {
  type: "object",
  required: ["teamId"],
  properties: {
    teamId: { type: "string", minLength: 1 }
  }
} as const;

const assetBodySchema = {
  type: "object",
  required: [
    "id",
    "type",
    "slug",
    "name",
    "summary",
    "description",
    "owner",
    "version",
    "risk",
    "tags",
    "usedBy",
    "updatedAt",
    "compatibility",
    "permissions",
    "requiredEnv",
    "files"
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    type: { type: "string", enum: assetTypes },
    slug: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    summary: { type: "string" },
    description: { type: "string" },
    owner: {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        avatarUrl: { type: "string" }
      }
    },
    version: { type: "string", minLength: 1 },
    risk: { type: "string", enum: riskLevels },
    tags: {
      type: "array",
      items: { type: "string" }
    },
    usedBy: { type: "number" },
    updatedAt: { type: "string" },
    compatibility: {
      type: "object",
      required: ["platforms"],
      properties: {
        claudeCode: { type: "string" },
        daemon: { type: "string" },
        platforms: {
          type: "array",
          items: { type: "string", enum: ["darwin", "linux", "windows"] }
        }
      }
    },
    permissions: {
      type: "array",
      items: {
        type: "object",
        required: ["label", "description", "level"],
        properties: {
          label: { type: "string" },
          description: { type: "string" },
          level: { type: "string", enum: riskLevels }
        }
      }
    },
    requiredEnv: {
      type: "array",
      items: { type: "string" }
    },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          executable: { type: "boolean" }
        }
      }
    }
  }
} as const;

export async function registerRoutes(app: FastifyInstance, repository: RegistryRepository) {
  app.get("/health", async () => ({
    ok: true,
    service: "claude-hub-api",
    version: "0.1.0"
  }));

  app.get<{
    Params: { teamId: string };
  }>(
    "/v1/teams/:teamId/catalog",
    {
      schema: {
        params: teamParamsSchema
      }
    },
    async (request, reply) => {
      const user = await authenticate(request.headers.authorization, repository);
      if (!user) {
        return reply.code(401).send({ error: "Unauthorized", message: "Nejdřív se přihlaste do Claude Hubu." });
      }

      return {
        teamId: request.params.teamId,
        assets: await repository.getCatalog(request.params.teamId)
      };
    }
  );

  app.post<{
    Body: CatalogAsset;
    Params: { teamId: string };
  }>(
    "/v1/teams/:teamId/catalog",
    {
      schema: {
        params: teamParamsSchema,
        body: assetBodySchema
      }
    },
    async (request, reply) => {
      const user = await authenticate(request.headers.authorization, repository);
      if (!user) {
        return reply.code(401).send({ error: "Unauthorized", message: "Nejdřív se přihlaste do Claude Hubu." });
      }

      const asset = await repository.publishAsset(request.params.teamId, {
        ...request.body,
        owner: {
          id: user.id,
          name: user.email
        }
      });
      return reply.code(201).send({ asset });
    }
  );

  app.post<{
    Body: { email: string };
  }>(
    "/v1/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", minLength: 3 }
          }
        }
      }
    },
    async (request) => repository.login(request.body.email)
  );

  app.get("/v1/auth/session", async (request, reply) => {
    const user = await authenticate(request.headers.authorization, repository);
    if (!user) {
      return reply.code(401).send({ error: "Unauthorized", message: "Nejdřív se přihlaste do Claude Hubu." });
    }

    return { user };
  });

  app.post("/v1/auth/logout", async (request) => {
    const token = bearerToken(request.headers.authorization);
    await repository.logout(token);
    return { ok: true };
  });

  app.post<{
    Body: { tokenHash: string; label: string; claudeHome: string };
  }>(
    "/v1/devices/pairing",
    {
      schema: {
        body: {
          type: "object",
          required: ["tokenHash", "label", "claudeHome"],
          properties: {
            tokenHash: { type: "string", minLength: 32 },
            label: { type: "string", minLength: 1 },
            claudeHome: { type: "string", minLength: 1 }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await authenticate(request.headers.authorization, repository);
      if (!user) {
        return reply.code(401).send({ error: "Unauthorized", message: "Nejdřív se přihlaste do Claude Hubu." });
      }

      await repository.upsertPairedDevice(
        user.id,
        request.body.tokenHash,
        request.body.label,
        request.body.claudeHome
      );
      return { ok: true };
    }
  );
}

async function authenticate(authorization: string | undefined, repository: RegistryRepository) {
  return repository.getSession(bearerToken(authorization));
}

function bearerToken(authorization: string | undefined) {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return "";
  }
  return authorization.slice(prefix.length).trim();
}
