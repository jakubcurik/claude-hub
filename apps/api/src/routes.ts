import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { CatalogAsset } from "@claude-hub/schema";
import { AuthError, computeContentHash, type RegistryRepository, type HubUser } from "./repository.js";
import { TelemetryRepository } from "./telemetry-repository.js";
import { registerTelemetryRoutes } from "./telemetry-routes.js";

const assetTypes = ["skill", "command", "mcp", "hook", "plugin", "config"] as const;
const riskLevels = ["low", "medium", "high", "restricted"] as const;
const memberRoles = ["owner", "admin", "member"] as const;

const teamParamsSchema = {
  type: "object",
  required: ["teamId"],
  properties: { teamId: { type: "string", minLength: 1 } }
} as const;

const teamAssetParamsSchema = {
  type: "object",
  required: ["teamId", "type", "slug"],
  properties: {
    teamId: { type: "string", minLength: 1 },
    type: { type: "string", enum: assetTypes },
    slug: { type: "string", minLength: 1 }
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
    tags: { type: "array", items: { type: "string" } },
    usedBy: { type: "number" },
    updatedAt: { type: "string" },
    compatibility: {
      type: "object",
      required: ["platforms"],
      properties: {
        claudeCode: { type: "string" },
        daemon: { type: "string" },
        platforms: { type: "array", items: { type: "string", enum: ["darwin", "linux", "windows"] } }
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
    requiredEnv: { type: "array", items: { type: "string" } },
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
    },
    contentHash: { type: "string" }
  }
} as const;

const publishBodySchema = {
  type: "object",
  required: ["asset"],
  properties: {
    asset: assetBodySchema,
    signature: {
      type: "object",
      required: ["signature", "publicKey"],
      properties: {
        signature: { type: "string", minLength: 1 },
        publicKey: { type: "string", minLength: 1 }
      }
    }
  }
} as const;

interface ErrorPayload {
  error: string;
  code: string;
  message: string;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  const payload: ErrorPayload = {
    error: defaultErrorTitle(status),
    code,
    message
  };
  return reply.code(status).send(payload);
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
    case 409:
      return "Conflict";
    case 422:
      return "Unprocessable Entity";
    case 429:
      return "Too Many Requests";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
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

async function requireMembership(
  reply: FastifyReply,
  repository: RegistryRepository,
  teamId: string,
  userId: string,
  minRole: "member" | "admin" | "owner" = "member"
) {
  const membership = await repository.getMembership(teamId, userId);
  if (!membership) {
    sendError(reply, 403, "forbidden", "Nemáte přístup k tomuto týmu.");
    return null;
  }
  if (!roleAtLeast(membership.role, minRole)) {
    sendError(reply, 403, "forbidden", "Tato akce vyžaduje vyšší oprávnění v týmu.");
    return null;
  }
  return membership;
}

function roleAtLeast(role: "owner" | "admin" | "member", required: "member" | "admin" | "owner") {
  const order = { member: 0, admin: 1, owner: 2 } as const;
  return order[role] >= order[required];
}

export async function registerRoutes(
  app: FastifyInstance,
  repository: RegistryRepository,
  telemetry: TelemetryRepository = new TelemetryRepository(repository.pool)
) {
  app.get("/health", async (_request, reply) => {
    try {
      await repository.ping();
      return { ok: true, service: "claude-hub-api", version: "0.1.0" };
    } catch (error) {
      app.log.warn({ error }, "/health database ping failed");
      return sendError(reply, 503, "database_unavailable", "Databáze není dostupná.");
    }
  });

  // ────────── Auth ──────────

  app.post<{
    Body: { email: string; password: string };
  }>(
    "/v1/auth/login",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" }
      },
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", minLength: 3, format: "email" },
            password: { type: "string", minLength: 1 }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        return await repository.login(request.body.email, request.body.password);
      } catch (error) {
        if (error instanceof AuthError) {
          return sendError(reply, error.status, error.code, error.message);
        }
        return sendError(
          reply,
          400,
          "invalid_email",
          error instanceof Error ? error.message : "Přihlášení se nepodařilo."
        );
      }
    }
  );

  app.post<{
    Body: { email: string; password: string };
  }>(
    "/v1/auth/register",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" }
      },
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", minLength: 3, format: "email" },
            password: { type: "string", minLength: 8 }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        return await repository.register(request.body.email, request.body.password);
      } catch (error) {
        if (error instanceof AuthError) {
          return sendError(reply, error.status, error.code, error.message);
        }
        return sendError(
          reply,
          400,
          "registration_failed",
          error instanceof Error ? error.message : "Registrace se nepodařila."
        );
      }
    }
  );

  app.get("/v1/auth/session", async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    return { user };
  });

  app.post("/v1/auth/logout", async (request) => {
    const token = bearerToken(request.headers.authorization);
    await repository.logout(token);
    return { ok: true };
  });

  // ────────── Team (single tenant) ──────────

  app.get("/v1/team", async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    const membership = await requireMembership(reply, repository, repository.teamId, user.id);
    if (!membership) return;
    const team = await repository.getTeam(repository.teamId);
    if (!team) {
      return sendError(reply, 404, "not_found", "Tým neexistuje.");
    }
    return { team, membership };
  });

  // ────────── Team members ──────────

  app.get<{ Params: { teamId: string } }>(
    "/v1/teams/:teamId/members",
    { schema: { params: teamParamsSchema } },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id);
      if (!membership) return;
      return { members: await repository.listTeamMembers(request.params.teamId) };
    }
  );

  app.delete<{ Params: { teamId: string; userId: string } }>(
    "/v1/teams/:teamId/members/:userId",
    {
      schema: {
        params: {
          type: "object",
          required: ["teamId", "userId"],
          properties: {
            teamId: { type: "string", minLength: 1 },
            userId: { type: "string", minLength: 1 }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id, "admin");
      if (!membership) return;

      if (request.params.userId === user.id) {
        return sendError(reply, 400, "self_remove", "Vlastní členství odeberte přes nastavení účtu.");
      }
      await repository.removeMember(request.params.teamId, request.params.userId);
      return { ok: true };
    }
  );

  app.patch<{
    Params: { teamId: string; userId: string };
    Body: { role: "admin" | "member" | "owner" };
  }>(
    "/v1/teams/:teamId/members/:userId",
    {
      schema: {
        params: {
          type: "object",
          required: ["teamId", "userId"],
          properties: {
            teamId: { type: "string", minLength: 1 },
            userId: { type: "string", minLength: 1 }
          }
        },
        body: {
          type: "object",
          required: ["role"],
          properties: { role: { type: "string", enum: memberRoles } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id, "owner");
      if (!membership) return;
      await repository.updateMemberRole(request.params.teamId, request.params.userId, request.body.role);
      return { ok: true };
    }
  );

  // ────────── Catalog ──────────

  app.get<{ Params: { teamId: string } }>(
    "/v1/teams/:teamId/catalog",
    { schema: { params: teamParamsSchema } },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id);
      if (!membership) return;
      return {
        teamId: request.params.teamId,
        assets: await repository.getCatalog(request.params.teamId)
      };
    }
  );

  app.post<{
    Body: { asset: CatalogAsset; signature?: { signature: string; publicKey: string } };
    Params: { teamId: string };
  }>(
    "/v1/teams/:teamId/catalog",
    {
      schema: {
        params: teamParamsSchema,
        body: publishBodySchema
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id);
      if (!membership) return;

      const incomingAsset = {
        ...request.body.asset,
        owner: { id: user.id, name: user.email }
      };

      let signatureRecord: { signature: string; signedBy: string } | undefined;
      if (request.body.signature) {
        const verified = await verifyAssetSignature(repository, incomingAsset, request.body.signature);
        if (!verified.ok) {
          return sendError(reply, 422, "invalid_signature", verified.reason);
        }
        if (verified.key.userId !== user.id) {
          return sendError(reply, 403, "signature_other_user", "Podpis nepatří přihlášenému uživateli.");
        }
        await repository.markSigningKeyUsed(verified.key.id);
        signatureRecord = { signature: request.body.signature.signature, signedBy: verified.key.id };
      }

      const asset = await repository.publishAsset(
        request.params.teamId,
        incomingAsset,
        user.id,
        signatureRecord
      );
      return reply.code(201).send({ asset });
    }
  );

  app.get<{ Params: { teamId: string; type: string; slug: string } }>(
    "/v1/teams/:teamId/catalog/:type/:slug/versions",
    { schema: { params: teamAssetParamsSchema } },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id);
      if (!membership) return;
      const versions = await repository.getAssetVersions(
        request.params.teamId,
        request.params.type,
        request.params.slug
      );
      if (versions.length === 0) {
        return sendError(reply, 404, "not_found", "Položka nemá žádné publikované verze.");
      }
      return { versions };
    }
  );

  app.post<{
    Params: { teamId: string; type: string; slug: string };
    Body: { version: string };
  }>(
    "/v1/teams/:teamId/catalog/:type/:slug/rollback",
    {
      schema: {
        params: teamAssetParamsSchema,
        body: {
          type: "object",
          required: ["version"],
          properties: { version: { type: "string", minLength: 1 } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id, "admin");
      if (!membership) return;
      try {
        const asset = await repository.rollbackAsset(
          request.params.teamId,
          request.params.type,
          request.params.slug,
          request.body.version,
          user.id
        );
        return { asset };
      } catch (error) {
        return sendError(
          reply,
          404,
          "version_not_found",
          error instanceof Error ? error.message : "Verze neexistuje."
        );
      }
    }
  );

  // ────────── Events ──────────

  app.get<{
    Params: { teamId: string };
    Querystring: { limit?: number };
  }>(
    "/v1/teams/:teamId/events",
    {
      schema: {
        params: teamParamsSchema,
        querystring: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 500 } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id);
      if (!membership) return;
      return {
        teamId: request.params.teamId,
        events: await repository.listEvents(request.params.teamId, request.query.limit ?? 100)
      };
    }
  );

  app.post<{
    Params: { teamId: string };
    Body: {
      event: string;
      assetId?: string;
      assetVersion?: string;
      metadata?: Record<string, unknown>;
    };
  }>(
    "/v1/teams/:teamId/events",
    {
      schema: {
        params: teamParamsSchema,
        body: {
          type: "object",
          required: ["event"],
          properties: {
            event: { type: "string", minLength: 1 },
            assetId: { type: "string" },
            assetVersion: { type: "string" },
            metadata: { type: "object" }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id);
      if (!membership) return;
      await repository.recordEvent({
        occurredAt: new Date().toISOString(),
        teamId: request.params.teamId,
        userId: user.id,
        event: request.body.event,
        assetId: request.body.assetId,
        assetVersion: request.body.assetVersion,
        metadata: request.body.metadata
      });
      return reply.code(201).send({ ok: true });
    }
  );

  // ────────── Devices ──────────

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
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      await repository.upsertPairedDevice(
        user.id,
        request.body.tokenHash,
        request.body.label,
        request.body.claudeHome
      );
      return { ok: true };
    }
  );

  app.get("/v1/devices", async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    return { devices: await repository.listPairedDevices(user.id) };
  });

  app.delete<{ Params: { tokenHash: string } }>(
    "/v1/devices/:tokenHash",
    {
      schema: {
        params: {
          type: "object",
          required: ["tokenHash"],
          properties: { tokenHash: { type: "string", minLength: 32 } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      await repository.revokePairedDevice(user.id, request.params.tokenHash);
      return { ok: true };
    }
  );

  // ────────── Collections ──────────

  app.get<{ Params: { teamId: string } }>(
    "/v1/teams/:teamId/collections",
    { schema: { params: teamParamsSchema } },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id);
      if (!membership) return;
      return { collections: await repository.listCollections(request.params.teamId) };
    }
  );

  app.put<{
    Params: { teamId: string };
    Body: { slug: string; name: string; description: string; assetIds: string[] };
  }>(
    "/v1/teams/:teamId/collections",
    {
      schema: {
        params: teamParamsSchema,
        body: {
          type: "object",
          required: ["slug", "name", "description", "assetIds"],
          properties: {
            slug: { type: "string", minLength: 2, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
            assetIds: { type: "array", items: { type: "string" } }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id, "admin");
      if (!membership) return;
      const collection = await repository.upsertCollection({
        teamId: request.params.teamId,
        slug: request.body.slug,
        name: request.body.name,
        description: request.body.description,
        assetIds: request.body.assetIds,
        createdBy: user.id
      });
      return reply.code(201).send({ collection });
    }
  );

  app.delete<{ Params: { teamId: string; slug: string } }>(
    "/v1/teams/:teamId/collections/:slug",
    {
      schema: {
        params: {
          type: "object",
          required: ["teamId", "slug"],
          properties: {
            teamId: { type: "string", minLength: 1 },
            slug: { type: "string", minLength: 1 }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      const membership = await requireMembership(reply, repository, request.params.teamId, user.id, "admin");
      if (!membership) return;
      await repository.deleteCollection(request.params.teamId, request.params.slug);
      return { ok: true };
    }
  );

  // ────────── Signing keys ──────────

  app.get("/v1/signing-keys", async (request, reply) => {
    const user = await requireUser(request, reply, repository);
    if (!user) return;
    return { keys: await repository.listSigningKeys(user.id) };
  });

  app.post<{
    Body: { label: string; publicKey: string };
  }>(
    "/v1/signing-keys",
    {
      schema: {
        body: {
          type: "object",
          required: ["label", "publicKey"],
          properties: {
            label: { type: "string", minLength: 1, maxLength: 80 },
            publicKey: { type: "string", minLength: 32 }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      try {
        // ověříme, že publicKey je validní Ed25519 SPKI v base64
        loadEd25519PublicKey(request.body.publicKey);
      } catch (error) {
        return sendError(
          reply,
          400,
          "invalid_public_key",
          error instanceof Error ? error.message : "Neplatný veřejný klíč."
        );
      }
      const key = await repository.registerSigningKey({
        userId: user.id,
        label: request.body.label,
        publicKey: request.body.publicKey
      });
      return reply.code(201).send({ key });
    }
  );

  app.delete<{ Params: { keyId: string } }>(
    "/v1/signing-keys/:keyId",
    {
      schema: {
        params: {
          type: "object",
          required: ["keyId"],
          properties: { keyId: { type: "string", minLength: 1 } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(request, reply, repository);
      if (!user) return;
      await repository.revokeSigningKey(user.id, request.params.keyId);
      return { ok: true };
    }
  );

  // ────────── Telemetry & analytics ──────────

  await registerTelemetryRoutes(app, { repository, telemetry });
}

function bearerToken(authorization: string | undefined) {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return "";
  }
  return authorization.slice(prefix.length).trim();
}

function loadEd25519PublicKey(base64Key: string) {
  // Akceptujeme jak raw 32-bajtový Ed25519 public key v base64,
  // tak DER/SPKI exportovaný `crypto.createPublicKey(...).export({format:'der',type:'spki'})`.
  const buffer = Buffer.from(base64Key, "base64");
  if (buffer.length === 32) {
    // Wrap raw key do SPKI prefixu pro Ed25519
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    return createPublicKey({
      key: Buffer.concat([spkiPrefix, buffer]),
      format: "der",
      type: "spki"
    });
  }
  return createPublicKey({
    key: buffer,
    format: "der",
    type: "spki"
  });
}

async function verifyAssetSignature(
  repository: RegistryRepository,
  asset: CatalogAsset,
  signature: { signature: string; publicKey: string }
): Promise<
  | { ok: true; key: { id: string; userId: string } }
  | { ok: false; reason: string }
> {
  const keyRecord = await repository.findSigningKeyByPublicKey(signature.publicKey);
  if (!keyRecord) {
    return { ok: false, reason: "Veřejný klíč není v Hubu zaregistrovaný." };
  }
  if (keyRecord.revokedAt) {
    return { ok: false, reason: "Veřejný klíč byl revoknutý." };
  }

  try {
    const publicKey = loadEd25519PublicKey(signature.publicKey);
    const message = Buffer.from(computeContentHash(asset), "utf8");
    const sig = Buffer.from(signature.signature, "base64");
    const valid = cryptoVerify(null, message, publicKey, sig);
    if (!valid) {
      return { ok: false, reason: "Podpis neodpovídá obsahu položky." };
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Podpis se nepodařilo ověřit."
    };
  }

  return { ok: true, key: { id: keyRecord.id, userId: keyRecord.userId } };
}
