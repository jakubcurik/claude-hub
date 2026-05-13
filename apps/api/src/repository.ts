import { Pool, type PoolConfig } from "pg";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Chyby z auth flow nesou HTTP status, aby je routes.ts mohly přemapovat
 * na JSON odpověď bez stringového matchování.
 */
export class AuthError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "AuthError";
  }
}
import type { CatalogAsset } from "@claude-hub/schema";
import { seedAssets } from "./seed-assets.js";

interface RegistryRepositoryOptions {
  databaseUrl?: string;
  pool?: Pool;
  teamId?: string;
  teamName?: string;
}

const DEFAULT_TEAM_ID = "main";
const DEFAULT_TEAM_NAME = "Tým";

interface CatalogRow {
  asset: CatalogAsset;
}

export interface HubUser {
  id: string;
  email: string;
  name: string;
  defaultTeamId: string;
}

export interface PairedDeviceSummary {
  tokenHash: string;
  label: string;
  claudeHome: string;
  lastSeenAt: string;
}

export interface CatalogAssetVersion {
  version: string;
  publishedAt: string;
  publishedBy: string;
  asset: CatalogAsset;
  signature?: string;
  signedBy?: string;
}

export interface CatalogEvent {
  occurredAt: string;
  event: string;
  userId: string;
  teamId: string;
  assetId?: string;
  assetVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  createdAt: string;
  createdBy: string;
}

export interface TeamMembership {
  teamId: string;
  userId: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

export interface Collection {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  description: string;
  assetIds: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface SigningKey {
  id: string;
  userId: string;
  label: string;
  publicKey: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  default_team_id: string;
  password_hash?: string | null;
}

export class RegistryRepository {
  /**
   * Pool je `public readonly` proto, aby ho mohly použít satelitní repository
   * třídy (TelemetryRepository) bez duplikace připojení. Vlastnictví se ale
   * deleguje sem (close() ho zavře).
   */
  public readonly pool: Pool;
  private readonly ownsPool: boolean;
  public readonly teamId: string;
  public readonly teamName: string;

  constructor(options: RegistryRepositoryOptions = {}) {
    this.teamId = options.teamId ?? process.env.CLAUDE_HUB_TEAM_ID ?? DEFAULT_TEAM_ID;
    this.teamName = options.teamName ?? process.env.CLAUDE_HUB_TEAM_NAME ?? DEFAULT_TEAM_NAME;

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
        password_hash text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Migrace pro starší instance, které ještě password_hash neměly. Stávající
    // uživatel s NULL password_hash si při prvním passwd-loginu nastaví heslo
    // přes register (claim flow).
    await this.pool.query(`
      ALTER TABLE hub_users ADD COLUMN IF NOT EXISTS password_hash text
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
      CREATE TABLE IF NOT EXISTS teams (
        id text PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        is_personal boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text NOT NULL
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        role text NOT NULL DEFAULT 'member',
        joined_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, user_id)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_assets (
        team_id text NOT NULL,
        type text NOT NULL,
        slug text NOT NULL,
        asset jsonb NOT NULL,
        content_hash text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, type, slug)
      )
    `);

    await this.pool.query(`
      ALTER TABLE catalog_assets ADD COLUMN IF NOT EXISTS content_hash text
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_asset_versions (
        team_id text NOT NULL,
        type text NOT NULL,
        slug text NOT NULL,
        version text NOT NULL,
        asset jsonb NOT NULL,
        content_hash text,
        signature text,
        signed_by text,
        published_at timestamptz NOT NULL DEFAULT now(),
        published_by text NOT NULL,
        PRIMARY KEY (team_id, type, slug, version)
      )
    `);

    await this.pool.query(`
      ALTER TABLE catalog_asset_versions ADD COLUMN IF NOT EXISTS signature text
    `);
    await this.pool.query(`
      ALTER TABLE catalog_asset_versions ADD COLUMN IF NOT EXISTS signed_by text
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_events (
        id bigserial PRIMARY KEY,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        team_id text NOT NULL,
        user_id text NOT NULL,
        event text NOT NULL,
        asset_id text,
        asset_version text,
        metadata jsonb
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS catalog_events_team_idx
        ON catalog_events (team_id, occurred_at DESC)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS collections (
        id text PRIMARY KEY,
        team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        slug text NOT NULL,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by text NOT NULL,
        UNIQUE (team_id, slug)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS signing_keys (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        label text NOT NULL,
        public_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      )
    `);

    // ────── Telemetry tables ──────

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS telemetry_metrics (
        id bigserial PRIMARY KEY,
        occurred_at timestamptz NOT NULL,
        user_id text NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        device_token_hash text NOT NULL,
        metric_name text NOT NULL,
        value double precision NOT NULL,
        session_id text,
        model text,
        attr_type text,
        terminal_type text,
        project_path text,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS telemetry_metrics_user_time_idx
        ON telemetry_metrics (user_id, occurred_at DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS telemetry_metrics_name_time_idx
        ON telemetry_metrics (metric_name, occurred_at DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS telemetry_metrics_project_idx
        ON telemetry_metrics (project_path, occurred_at DESC)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id bigserial PRIMARY KEY,
        occurred_at timestamptz NOT NULL,
        user_id text NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        device_token_hash text NOT NULL,
        event_name text NOT NULL,
        session_id text,
        skill_name text,
        plugin_name text,
        marketplace_name text,
        project_path text,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS telemetry_events_user_time_idx
        ON telemetry_events (user_id, occurred_at DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS telemetry_events_project_idx
        ON telemetry_events (project_path, occurred_at DESC)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS telemetry_daily_user_project (
        day date NOT NULL,
        user_id text NOT NULL,
        project_path text NOT NULL DEFAULT '',
        sessions int NOT NULL DEFAULT 0,
        tokens_input bigint NOT NULL DEFAULT 0,
        tokens_output bigint NOT NULL DEFAULT 0,
        tokens_cache_read bigint NOT NULL DEFAULT 0,
        tokens_cache_create bigint NOT NULL DEFAULT 0,
        cost_usd numeric(12,4) NOT NULL DEFAULT 0,
        active_seconds bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (day, user_id, project_path)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS telemetry_daily_project_idx
        ON telemetry_daily_user_project (project_path, day DESC)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS telemetry_settings (
        user_id text PRIMARY KEY REFERENCES hub_users(id) ON DELETE CASCADE,
        opted_in boolean NOT NULL DEFAULT true,
        opted_in_at timestamptz NOT NULL DEFAULT now(),
        disabled_by_owner boolean NOT NULL DEFAULT false,
        disabled_at timestamptz
      )
    `);

    // Single-tenant: vytvoříme tým z env proměnných (default `main`), pokud ještě neexistuje.
    await this.pool.query(
      `
        INSERT INTO teams (id, name, slug, is_personal, created_by)
        VALUES ($1, $2, $1, false, 'system')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      `,
      [this.teamId, this.teamName]
    );

    for (const asset of seedAssets) {
      await this.upsertAsset(this.teamId, normalizePublishedAsset(asset), false, "seed");
    }
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  async cleanupExpiredSessions() {
    await this.pool.query(`DELETE FROM hub_sessions WHERE expires_at < now() - interval '7 days'`);
  }

  async close() {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  // ────────────────── Auth ──────────────────

  async login(
    email: string,
    password: string
  ): Promise<{ user: HubUser; sessionToken: string; expiresAt: string }> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      throw new AuthError(400, "missing_fields", "E-mail i heslo jsou povinné.");
    }

    const result = await this.pool.query<UserRow>(
      `SELECT id, email, name, default_team_id, password_hash FROM hub_users WHERE email = $1`,
      [normalizedEmail]
    );

    const user = result.rows[0];
    // Generic message pro user-not-found i špatné heslo — nedovolíme útočníkovi
    // zjistit, který e-mail v systému existuje (user enumeration).
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      throw new AuthError(401, "invalid_credentials", "Nesprávný e-mail nebo heslo.");
    }

    return this.createSession(user);
  }

  async register(
    email: string,
    password: string
  ): Promise<{ user: HubUser; sessionToken: string; expiresAt: string }> {
    if (!password || password.length < 8) {
      throw new AuthError(400, "weak_password", "Heslo musí mít alespoň 8 znaků.");
    }

    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      throw new AuthError(400, "missing_email", "E-mail je povinný.");
    }

    const allowed = getAllowedEmailEntries();
    if (allowed.length === 0) {
      // Bez allowlistu by se mohl zaregistrovat kdokoli — to je pro veřejně
      // dostupný hub nebezpečné. Admin musí nastavit alespoň povolenou doménu.
      throw new AuthError(503, "registration_disabled", "Registrace není nakonfigurovaná. Kontaktujte správce.");
    }

    if (!isEmailAllowed(normalizedEmail, allowed)) {
      throw new AuthError(403, "email_not_allowed", "Tento e-mail nemá přístup k hubu.");
    }

    const passwordHash = hashPassword(password);
    const name = normalizedEmail.split("@")[0] || normalizedEmail;

    const existing = await this.pool.query<UserRow>(
      `SELECT id, email, name, default_team_id, password_hash FROM hub_users WHERE email = $1`,
      [normalizedEmail]
    );

    let user: UserRow;

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.password_hash) {
        // Účet existuje a má nastavené heslo — žádné přepisování.
        throw new AuthError(409, "user_exists", "Účet s tímto e-mailem už existuje. Zkuste se přihlásit.");
      }
      // Claim flow: starý účet z passwordless éry, nastav mu heslo.
      const update = await this.pool.query<UserRow>(
        `
          UPDATE hub_users
          SET password_hash = $1, name = $2
          WHERE id = $3
          RETURNING id, email, name, default_team_id, password_hash
        `,
        [passwordHash, name, row.id]
      );
      user = update.rows[0];
    } else {
      const userId = "user_" + sha256(normalizedEmail).slice(0, 24);
      const insert = await this.pool.query<UserRow>(
        `
          INSERT INTO hub_users (id, email, name, default_team_id, password_hash)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, email, name, default_team_id, password_hash
        `,
        [userId, normalizedEmail, name, this.teamId, passwordHash]
      );
      user = insert.rows[0];

      const memberCount = await this.pool.query<{ count: string }>(
        `SELECT count(*)::text FROM team_members WHERE team_id = $1`,
        [this.teamId]
      );
      const role = Number(memberCount.rows[0].count) === 0 ? "owner" : "member";
      await this.pool.query(
        `
          INSERT INTO team_members (team_id, user_id, role)
          VALUES ($1, $2, $3)
          ON CONFLICT (team_id, user_id) DO NOTHING
        `,
        [this.teamId, user.id, role]
      );
    }

    return this.createSession(user);
  }

  private async createSession(
    user: UserRow
  ): Promise<{ user: HubUser; sessionToken: string; expiresAt: string }> {
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await this.pool.query(
      `INSERT INTO hub_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
      [sha256(sessionToken), user.id, expiresAt]
    );

    return {
      user: toHubUser(user),
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

  // ────────────────── Catalog ──────────────────

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

  async publishAsset(
    teamId: string,
    asset: CatalogAsset,
    publishedBy: string,
    signature?: { signature: string; signedBy: string }
  ) {
    return this.upsertAsset(teamId, normalizePublishedAsset(asset), true, publishedBy, signature);
  }

  async getAssetVersions(teamId: string, type: string, slug: string): Promise<CatalogAssetVersion[]> {
    const result = await this.pool.query<{
      version: string;
      published_at: Date;
      published_by: string;
      asset: CatalogAsset;
      signature: string | null;
      signed_by: string | null;
    }>(
      `
        SELECT version, published_at, published_by, asset, signature, signed_by
        FROM catalog_asset_versions
        WHERE team_id = $1 AND type = $2 AND slug = $3
        ORDER BY published_at DESC
      `,
      [teamId, type, slug]
    );

    return result.rows.map((row) => ({
      version: row.version,
      publishedAt: row.published_at.toISOString(),
      publishedBy: row.published_by,
      asset: row.asset,
      signature: row.signature ?? undefined,
      signedBy: row.signed_by ?? undefined
    }));
  }

  async rollbackAsset(teamId: string, type: string, slug: string, version: string, byUser: string) {
    const result = await this.pool.query<{ asset: CatalogAsset; content_hash: string | null }>(
      `
        SELECT asset, content_hash
        FROM catalog_asset_versions
        WHERE team_id = $1 AND type = $2 AND slug = $3 AND version = $4
      `,
      [teamId, type, slug, version]
    );
    if (result.rows.length === 0) {
      throw new Error("Verze neexistuje.");
    }

    const asset = result.rows[0].asset;
    await this.pool.query(
      `
        INSERT INTO catalog_assets (team_id, type, slug, asset, content_hash, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, now())
        ON CONFLICT (team_id, type, slug)
        DO UPDATE SET asset = EXCLUDED.asset, content_hash = EXCLUDED.content_hash, updated_at = now()
      `,
      [teamId, type, slug, JSON.stringify(asset), result.rows[0].content_hash]
    );

    await this.recordEvent({
      occurredAt: new Date().toISOString(),
      teamId,
      userId: byUser,
      event: "rollback",
      assetId: asset.id,
      assetVersion: version,
      metadata: { contentHash: result.rows[0].content_hash }
    });

    return asset;
  }

  // ────────────────── Devices ──────────────────

  async listPairedDevices(userId: string): Promise<PairedDeviceSummary[]> {
    const result = await this.pool.query<{
      token_hash: string;
      label: string;
      claude_home: string;
      last_seen_at: Date;
    }>(
      `
        SELECT token_hash, label, claude_home, last_seen_at
        FROM paired_devices
        WHERE user_id = $1
        ORDER BY last_seen_at DESC
      `,
      [userId]
    );

    return result.rows.map((row) => ({
      tokenHash: row.token_hash,
      label: row.label,
      claudeHome: row.claude_home,
      lastSeenAt: row.last_seen_at.toISOString()
    }));
  }

  async revokePairedDevice(userId: string, tokenHash: string) {
    await this.pool.query(
      `DELETE FROM paired_devices WHERE user_id = $1 AND token_hash = $2`,
      [userId, tokenHash]
    );
  }

  /**
   * Vyhledá zařízení podle nehasovaného pairing tokenu (Bearer od daemonu).
   * Token uložený v DB je SHA-256 hash, takže porovnání děláme přes hash.
   * Zároveň posune `last_seen_at`, aby admin viděl, že zařízení žije.
   */
  async resolveDeviceByPairingToken(
    token: string
  ): Promise<{ userId: string; tokenHash: string } | null> {
    const trimmed = token.trim();
    if (!trimmed) return null;
    const tokenHash = sha256(trimmed);
    const result = await this.pool.query<{ user_id: string }>(
      `
        UPDATE paired_devices
        SET last_seen_at = now()
        WHERE token_hash = $1
        RETURNING user_id
      `,
      [tokenHash]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return { userId: result.rows[0].user_id, tokenHash };
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

  // ────────────────── Events ──────────────────

  async recordEvent(event: CatalogEvent) {
    await this.pool.query(
      `
        INSERT INTO catalog_events (occurred_at, team_id, user_id, event, asset_id, asset_version, metadata)
        VALUES (COALESCE($1, now()), $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        event.occurredAt ? new Date(event.occurredAt) : null,
        event.teamId,
        event.userId,
        event.event,
        event.assetId ?? null,
        event.assetVersion ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null
      ]
    );
  }

  async listEvents(teamId: string, limit = 100): Promise<CatalogEvent[]> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const result = await this.pool.query<{
      occurred_at: Date;
      team_id: string;
      user_id: string;
      event: string;
      asset_id: string | null;
      asset_version: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT occurred_at, team_id, user_id, event, asset_id, asset_version, metadata
        FROM catalog_events
        WHERE team_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2
      `,
      [teamId, safeLimit]
    );

    return result.rows.map((row) => ({
      occurredAt: row.occurred_at.toISOString(),
      teamId: row.team_id,
      userId: row.user_id,
      event: row.event,
      assetId: row.asset_id ?? undefined,
      assetVersion: row.asset_version ?? undefined,
      metadata: row.metadata ?? undefined
    }));
  }

  // ────────────────── Teams ──────────────────

  async getTeam(teamId: string): Promise<Team | null> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      slug: string;
      is_personal: boolean;
      created_at: Date;
      created_by: string;
    }>(`SELECT id, name, slug, is_personal, created_at, created_by FROM teams WHERE id = $1`, [teamId]);
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isPersonal: row.is_personal,
      createdAt: row.created_at.toISOString(),
      createdBy: row.created_by
    };
  }

  async listTeamMembers(teamId: string): Promise<TeamMembership[]> {
    const result = await this.pool.query<{
      team_id: string;
      user_id: string;
      email: string;
      name: string;
      role: "owner" | "admin" | "member";
      joined_at: Date;
    }>(
      `
        SELECT m.team_id, m.user_id, u.email, u.name, m.role, m.joined_at
        FROM team_members m
        JOIN hub_users u ON u.id = m.user_id
        WHERE m.team_id = $1
        ORDER BY
          CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
          m.joined_at ASC
      `,
      [teamId]
    );

    return result.rows.map((row) => ({
      teamId: row.team_id,
      userId: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      joinedAt: row.joined_at.toISOString()
    }));
  }

  async getMembership(teamId: string, userId: string): Promise<TeamMembership | null> {
    const result = await this.pool.query<{
      team_id: string;
      user_id: string;
      email: string;
      name: string;
      role: "owner" | "admin" | "member";
      joined_at: Date;
    }>(
      `
        SELECT m.team_id, m.user_id, u.email, u.name, m.role, m.joined_at
        FROM team_members m
        JOIN hub_users u ON u.id = m.user_id
        WHERE m.team_id = $1 AND m.user_id = $2
      `,
      [teamId, userId]
    );

    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    return {
      teamId: row.team_id,
      userId: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      joinedAt: row.joined_at.toISOString()
    };
  }

  async removeMember(teamId: string, userId: string) {
    await this.pool.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [teamId, userId]);
  }

  async updateMemberRole(teamId: string, userId: string, role: "admin" | "member" | "owner") {
    await this.pool.query(
      `UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId, role]
    );
  }


  // ────────────────── Collections ──────────────────

  async listCollections(teamId: string): Promise<Collection[]> {
    const result = await this.pool.query<{
      id: string;
      team_id: string;
      slug: string;
      name: string;
      description: string;
      asset_ids: string[];
      created_at: Date;
      updated_at: Date;
      created_by: string;
    }>(
      `
        SELECT id, team_id, slug, name, description, asset_ids, created_at, updated_at, created_by
        FROM collections
        WHERE team_id = $1
        ORDER BY updated_at DESC
      `,
      [teamId]
    );

    return result.rows.map((row) => ({
      id: row.id,
      teamId: row.team_id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      assetIds: Array.isArray(row.asset_ids) ? row.asset_ids : [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      createdBy: row.created_by
    }));
  }

  async upsertCollection(input: {
    teamId: string;
    slug: string;
    name: string;
    description: string;
    assetIds: string[];
    createdBy: string;
  }): Promise<Collection> {
    const id = "col_" + sha256(input.teamId + ":" + input.slug).slice(0, 16);
    const result = await this.pool.query<{
      id: string;
      team_id: string;
      slug: string;
      name: string;
      description: string;
      asset_ids: string[];
      created_at: Date;
      updated_at: Date;
      created_by: string;
    }>(
      `
        INSERT INTO collections (id, team_id, slug, name, description, asset_ids, created_by)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (team_id, slug)
        DO UPDATE SET name = EXCLUDED.name,
                      description = EXCLUDED.description,
                      asset_ids = EXCLUDED.asset_ids,
                      updated_at = now()
        RETURNING id, team_id, slug, name, description, asset_ids, created_at, updated_at, created_by
      `,
      [
        id,
        input.teamId,
        input.slug,
        input.name,
        input.description,
        JSON.stringify(input.assetIds),
        input.createdBy
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      teamId: row.team_id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      assetIds: Array.isArray(row.asset_ids) ? row.asset_ids : [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      createdBy: row.created_by
    };
  }

  async deleteCollection(teamId: string, slug: string) {
    await this.pool.query(`DELETE FROM collections WHERE team_id = $1 AND slug = $2`, [teamId, slug]);
  }

  // ────────────────── Signing keys ──────────────────

  async listSigningKeys(userId: string, includeRevoked = false): Promise<SigningKey[]> {
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      label: string;
      public_key: string;
      created_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>(
      includeRevoked
        ? `
            SELECT id, user_id, label, public_key, created_at, last_used_at, revoked_at
            FROM signing_keys
            WHERE user_id = $1
            ORDER BY created_at DESC
          `
        : `
            SELECT id, user_id, label, public_key, created_at, last_used_at, revoked_at
            FROM signing_keys
            WHERE user_id = $1 AND revoked_at IS NULL
            ORDER BY created_at DESC
          `,
      [userId]
    );

    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      label: row.label,
      publicKey: row.public_key,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null
    }));
  }

  async registerSigningKey(input: { userId: string; label: string; publicKey: string }): Promise<SigningKey> {
    const id = "key_" + sha256(input.publicKey).slice(0, 20);
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      label: string;
      public_key: string;
      created_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>(
      `
        INSERT INTO signing_keys (id, user_id, label, public_key)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, revoked_at = NULL
        RETURNING id, user_id, label, public_key, created_at, last_used_at, revoked_at
      `,
      [id, input.userId, input.label, input.publicKey]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      label: row.label,
      publicKey: row.public_key,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null
    };
  }

  async revokeSigningKey(userId: string, keyId: string) {
    await this.pool.query(
      `UPDATE signing_keys SET revoked_at = now() WHERE user_id = $1 AND id = $2`,
      [userId, keyId]
    );
  }

  async findSigningKeyByPublicKey(publicKey: string): Promise<SigningKey | null> {
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      label: string;
      public_key: string;
      created_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>(
      `
        SELECT id, user_id, label, public_key, created_at, last_used_at, revoked_at
        FROM signing_keys
        WHERE public_key = $1
      `,
      [publicKey]
    );
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      label: row.label,
      publicKey: row.public_key,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null
    };
  }

  async markSigningKeyUsed(keyId: string) {
    await this.pool.query(`UPDATE signing_keys SET last_used_at = now() WHERE id = $1`, [keyId]);
  }

  // ────────────────── Internal helpers ──────────────────

  private async upsertAsset(
    teamId: string,
    asset: CatalogAsset,
    overwrite: boolean,
    publishedBy: string,
    signature?: { signature: string; signedBy: string }
  ) {
    const contentHash = computeContentHash(asset);
    const enrichedAsset: CatalogAsset & { contentHash?: string } = {
      ...asset,
      contentHash
    };

    const conflictAction = overwrite
      ? `DO UPDATE SET asset = EXCLUDED.asset, content_hash = EXCLUDED.content_hash, updated_at = EXCLUDED.updated_at`
      : `DO NOTHING`;

    const result = await this.pool.query<CatalogRow>(
      `
        INSERT INTO catalog_assets (team_id, type, slug, asset, content_hash, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (team_id, type, slug)
        ${conflictAction}
        RETURNING asset
      `,
      [teamId, asset.type, asset.slug, JSON.stringify(enrichedAsset), contentHash, asset.updatedAt]
    );

    if (overwrite || result.rowCount === 1) {
      await this.pool.query(
        `
          INSERT INTO catalog_asset_versions (team_id, type, slug, version, asset, content_hash, signature, signed_by, published_by)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
          ON CONFLICT (team_id, type, slug, version)
          DO UPDATE SET asset = EXCLUDED.asset,
                        content_hash = EXCLUDED.content_hash,
                        signature = EXCLUDED.signature,
                        signed_by = EXCLUDED.signed_by,
                        published_at = now(),
                        published_by = EXCLUDED.published_by
        `,
        [
          teamId,
          asset.type,
          asset.slug,
          asset.version,
          JSON.stringify(enrichedAsset),
          contentHash,
          signature?.signature ?? null,
          signature?.signedBy ?? null,
          publishedBy
        ]
      );

      await this.recordEvent({
        occurredAt: new Date().toISOString(),
        teamId,
        userId: publishedBy,
        event: "publish",
        assetId: asset.id,
        assetVersion: asset.version,
        metadata: { contentHash, signed: Boolean(signature) }
      });
    }

    return result.rows[0]?.asset ?? enrichedAsset;
  }
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// scrypt s 16B saltem a 64B hashem. Výstup ve formátu `salt:hash` (oba hex).
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

function hashPassword(plain: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(plain, salt, SCRYPT_KEYLEN);
  // Constant-time compare — nedovolíme útočníkovi timing-attack na hash byty.
  return timingSafeEqual(expected, actual);
}

/**
 * Načte allowlist z CLAUDE_HUB_ALLOWED_EMAILS (oddělené čárkou nebo mezerou).
 * Položka může být buď konkrétní e-mail (obsahuje `@`) nebo doména
 * (`animato.cz` → projde každý `*@animato.cz`). Prázdné = registrace zakázaná.
 */
function getAllowedEmailEntries(): string[] {
  const raw = (process.env.CLAUDE_HUB_ALLOWED_EMAILS ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isEmailAllowed(email: string, entries: string[]): boolean {
  return entries.some((entry) => {
    if (entry.includes("@")) {
      return entry === email;
    }
    return email.endsWith("@" + entry);
  });
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

export function computeContentHash(asset: CatalogAsset): string {
  const canonical = JSON.stringify(
    [...asset.files]
      .map((file) => ({ path: file.path, content: file.content, executable: file.executable ?? false }))
      .sort((a, b) => a.path.localeCompare(b.path))
  );
  return createHash("sha256").update(canonical).digest("hex");
}
