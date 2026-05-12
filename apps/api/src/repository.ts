import { Pool, type PoolConfig } from "pg";
import { createHash, randomBytes } from "node:crypto";
import type { CatalogAsset } from "@claude-hub/schema";
import { seedAssets } from "./seed-assets.js";

interface RegistryRepositoryOptions {
  databaseUrl?: string;
  pool?: Pool;
}

interface CatalogRow {
  asset: CatalogAsset;
}

export interface HubUser {
  id: string;
  email: string;
  name: string;
  defaultTeamId: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  default_team_id: string;
}

export class RegistryRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: RegistryRepositoryOptions = {}) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
      return;
    }

    const connectionString = options.databaseUrl ?? process.env.CLAUDE_HUB_DATABASE_URL;
    if (!connectionString) {
      throw new Error("Chybí CLAUDE_HUB_DATABASE_URL.");
    }

    const config: PoolConfig = { connectionString };
    this.pool = new Pool(config);
    this.ownsPool = true;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS hub_users (
        id text PRIMARY KEY,
        email text NOT NULL UNIQUE,
        name text NOT NULL,
        default_team_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS hub_sessions (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS paired_devices (
        user_id text NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        label text NOT NULL,
        claude_home text NOT NULL,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, token_hash)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_assets (
        team_id text NOT NULL,
        type text NOT NULL,
        slug text NOT NULL,
        asset jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, type, slug)
      )
    `);

    for (const asset of seedAssets) {
      await this.upsertAsset("demo-team", normalizePublishedAsset(asset), false);
    }
  }

  async close() {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async getCatalog(teamId: string) {
    const result = await this.pool.query<CatalogRow>(
      `
        SELECT asset
        FROM catalog_assets
        WHERE team_id = $1
        ORDER BY updated_at DESC, slug ASC
      `,
      [teamId]
    );

    return result.rows.map((row) => row.asset);
  }

  async publishAsset(teamId: string, asset: CatalogAsset) {
    return this.upsertAsset(teamId, normalizePublishedAsset(asset), true);
  }

  async login(email: string): Promise<{ user: HubUser; sessionToken: string; expiresAt: string }> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      throw new Error("E-mail je povinný.");
    }

    const name = normalizedEmail.split("@")[0] || normalizedEmail;
    const id = "user_" + sha256(normalizedEmail).slice(0, 24);
    const defaultTeamId = "demo-team";

    const userResult = await this.pool.query<UserRow>(
      `
        INSERT INTO hub_users (id, email, name, default_team_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email)
        DO UPDATE SET name = EXCLUDED.name
        RETURNING id, email, name, default_team_id
      `,
      [id, normalizedEmail, name, defaultTeamId]
    );

    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await this.pool.query(
      `
        INSERT INTO hub_sessions (token_hash, user_id, expires_at)
        VALUES ($1, $2, $3)
      `,
      [sha256(sessionToken), userResult.rows[0].id, expiresAt]
    );

    return {
      user: toHubUser(userResult.rows[0]),
      sessionToken,
      expiresAt
    };
  }

  async getSession(sessionToken: string): Promise<HubUser | null> {
    if (!sessionToken) {
      return null;
    }

    const result = await this.pool.query<UserRow>(
      `
        SELECT u.id, u.email, u.name, u.default_team_id
        FROM hub_sessions s
        JOIN hub_users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > now()
      `,
      [sha256(sessionToken)]
    );

    return result.rows[0] ? toHubUser(result.rows[0]) : null;
  }

  async logout(sessionToken: string) {
    if (!sessionToken) {
      return;
    }
    await this.pool.query(`DELETE FROM hub_sessions WHERE token_hash = $1`, [sha256(sessionToken)]);
  }

  async upsertPairedDevice(userId: string, tokenHash: string, label: string, claudeHome: string) {
    if (!tokenHash || !label || !claudeHome) {
      throw new Error("Metadata zařízení nejsou kompletní.");
    }

    await this.pool.query(
      `
        INSERT INTO paired_devices (user_id, token_hash, label, claude_home, last_seen_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (user_id, token_hash)
        DO UPDATE SET label = EXCLUDED.label, claude_home = EXCLUDED.claude_home, last_seen_at = now()
      `,
      [userId, tokenHash, label, claudeHome]
    );
  }

  private async upsertAsset(teamId: string, asset: CatalogAsset, overwrite: boolean) {
    const conflictAction = overwrite
      ? `DO UPDATE SET asset = EXCLUDED.asset, updated_at = EXCLUDED.updated_at`
      : `DO NOTHING`;

    const result = await this.pool.query<CatalogRow>(
      `
        INSERT INTO catalog_assets (team_id, type, slug, asset, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (team_id, type, slug)
        ${conflictAction}
        RETURNING asset
      `,
      [teamId, asset.type, asset.slug, JSON.stringify(asset), asset.updatedAt]
    );

    return result.rows[0]?.asset ?? asset;
  }
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function toHubUser(row: UserRow): HubUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    defaultTeamId: row.default_team_id
  };
}

function normalizePublishedAsset(asset: CatalogAsset): CatalogAsset {
  return {
    ...asset,
    owner: asset.owner ?? {
      id: "local-user",
      name: "Lokální uživatel"
    },
    tags: asset.tags ?? [],
    usedBy: asset.usedBy ?? 0,
    updatedAt: new Date().toISOString(),
    permissions: asset.permissions ?? [],
    requiredEnv: asset.requiredEnv ?? [],
    files: asset.files ?? []
  };
}
