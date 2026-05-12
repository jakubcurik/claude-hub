import type { Pool } from "pg";
import type {
  TelemetryBufferItem,
  TelemetryDailyTeamPoint,
  TelemetryProjectAggregate,
  TelemetryUserAggregate,
  TelemetryModelMixRow,
  TelemetryBreakdownItem,
  TelemetryCostPerDevPoint,
  TelemetryTotals,
  TelemetryOverview,
  TelemetryFilters,
  TelemetryProjectsListItem,
  TelemetryUserSettingRow
} from "@claude-hub/schema";

interface IngestRow {
  occurredAt: Date;
  metricName?: string;
  eventName?: string;
  value?: number;
  sessionId: string | null;
  model: string | null;
  attrType: string | null;
  terminalType: string | null;
  projectPath: string | null;
  skillName: string | null;
  pluginName: string | null;
  marketplaceName: string | null;
  attributes: Record<string, string>;
}

const RETENTION_DAYS = 365;

/**
 * TelemetryRepository drží všechny Postgres queries pro telemetry pipeline:
 * příjem dat od daemonů, agregace a čtení dashboardových výřezů.
 */
export class TelemetryRepository {
  constructor(private readonly pool: Pool) {}

  // ─────────── Settings ───────────

  async getSettings(userId: string): Promise<{ optedIn: boolean; disabledByOwner: boolean }> {
    const result = await this.pool.query<{ opted_in: boolean; disabled_by_owner: boolean }>(
      `SELECT opted_in, disabled_by_owner FROM telemetry_settings WHERE user_id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      // Auto-on po pairingu — pokud user nemá řádek, vrátíme default.
      return { optedIn: true, disabledByOwner: false };
    }
    return {
      optedIn: result.rows[0].opted_in,
      disabledByOwner: result.rows[0].disabled_by_owner
    };
  }

  async ensureSettings(userId: string) {
    await this.pool.query(
      `INSERT INTO telemetry_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
  }

  async setOwnerDisabled(userId: string, disabled: boolean) {
    await this.pool.query(
      `
        INSERT INTO telemetry_settings (user_id, disabled_by_owner, disabled_at)
        VALUES ($1, $2, CASE WHEN $2 THEN now() ELSE NULL END)
        ON CONFLICT (user_id) DO UPDATE
          SET disabled_by_owner = EXCLUDED.disabled_by_owner,
              disabled_at = EXCLUDED.disabled_at
      `,
      [userId, disabled]
    );
  }

  async listUserSettings(teamId: string): Promise<TelemetryUserSettingRow[]> {
    const result = await this.pool.query<{
      user_id: string;
      email: string;
      opted_in: boolean;
      opted_in_at: Date;
      disabled_by_owner: boolean;
      disabled_at: Date | null;
    }>(
      `
        SELECT u.id AS user_id,
               u.email,
               COALESCE(t.opted_in, true) AS opted_in,
               COALESCE(t.opted_in_at, now()) AS opted_in_at,
               COALESCE(t.disabled_by_owner, false) AS disabled_by_owner,
               t.disabled_at
        FROM team_members m
        JOIN hub_users u ON u.id = m.user_id
        LEFT JOIN telemetry_settings t ON t.user_id = u.id
        WHERE m.team_id = $1
        ORDER BY u.email
      `,
      [teamId]
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      userEmail: row.email,
      optedIn: row.opted_in,
      disabledByOwner: row.disabled_by_owner,
      optedInAt: row.opted_in_at.toISOString(),
      disabledAt: row.disabled_at?.toISOString()
    }));
  }

  // ─────────── Ingest ───────────

  /**
   * Zápis batchu od daemonu. Vrací počet uložených řádků / dropnutých.
   * Insert je batched přes UNNEST, aby 500 itemů byl jeden round-trip.
   */
  async ingest(
    userId: string,
    tokenHash: string,
    items: TelemetryBufferItem[]
  ): Promise<{ accepted: number; dropped: number }> {
    const settings = await this.getSettings(userId);
    if (settings.disabledByOwner) {
      return { accepted: 0, dropped: items.length };
    }

    const metricRows: IngestRow[] = [];
    const eventRows: IngestRow[] = [];

    for (const item of items) {
      if (item.kind === "metric" && item.metric) {
        metricRows.push(buildRowFromMetric(item.metric));
      } else if (item.kind === "event" && item.event) {
        eventRows.push(buildRowFromEvent(item.event));
      }
    }

    if (metricRows.length > 0) {
      await this.insertMetrics(userId, tokenHash, metricRows);
    }
    if (eventRows.length > 0) {
      await this.insertEvents(userId, tokenHash, eventRows);
    }
    return { accepted: metricRows.length + eventRows.length, dropped: 0 };
  }

  private async insertMetrics(userId: string, tokenHash: string, rows: IngestRow[]) {
    await this.pool.query(
      `
        INSERT INTO telemetry_metrics (
          occurred_at, user_id, device_token_hash, metric_name, value,
          session_id, model, attr_type, terminal_type, project_path, attributes
        )
        SELECT * FROM UNNEST(
          $1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::double precision[],
          $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::jsonb[]
        )
      `,
      [
        rows.map((r) => r.occurredAt),
        rows.map(() => userId),
        rows.map(() => tokenHash),
        rows.map((r) => r.metricName ?? ""),
        rows.map((r) => r.value ?? 0),
        rows.map((r) => r.sessionId),
        rows.map((r) => r.model),
        rows.map((r) => r.attrType),
        rows.map((r) => r.terminalType),
        rows.map((r) => r.projectPath),
        rows.map((r) => JSON.stringify(r.attributes))
      ]
    );
  }

  private async insertEvents(userId: string, tokenHash: string, rows: IngestRow[]) {
    await this.pool.query(
      `
        INSERT INTO telemetry_events (
          occurred_at, user_id, device_token_hash, event_name,
          session_id, skill_name, plugin_name, marketplace_name, project_path, attributes
        )
        SELECT * FROM UNNEST(
          $1::timestamptz[], $2::text[], $3::text[], $4::text[],
          $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::jsonb[]
        )
      `,
      [
        rows.map((r) => r.occurredAt),
        rows.map(() => userId),
        rows.map(() => tokenHash),
        rows.map((r) => r.eventName ?? ""),
        rows.map((r) => r.sessionId),
        rows.map((r) => r.skillName),
        rows.map((r) => r.pluginName),
        rows.map((r) => r.marketplaceName),
        rows.map((r) => r.projectPath),
        rows.map((r) => JSON.stringify(r.attributes))
      ]
    );
  }

  // ─────────── Aggregator ───────────

  /**
   * Spočítá denní rollupy za posledních 48 hodin (UPSERT). Voláno z
   * aggregator workeru, aby pozdě doručená data nezpůsobila chyby v
   * dashboardu starších dní.
   */
  async runRollupTick() {
    await this.pool.query(`
      WITH source AS (
        SELECT
          date_trunc('day', occurred_at)::date AS day,
          user_id,
          COALESCE(project_path, '') AS project_path,
          count(*) FILTER (WHERE metric_name = 'claude_code.session.count') AS sessions,
          coalesce(sum(value) FILTER (
            WHERE metric_name = 'claude_code.token.usage' AND attr_type = 'input'
          ), 0)::bigint AS tokens_input,
          coalesce(sum(value) FILTER (
            WHERE metric_name = 'claude_code.token.usage' AND attr_type = 'output'
          ), 0)::bigint AS tokens_output,
          coalesce(sum(value) FILTER (
            WHERE metric_name = 'claude_code.token.usage' AND attr_type = 'cacheRead'
          ), 0)::bigint AS tokens_cache_read,
          coalesce(sum(value) FILTER (
            WHERE metric_name = 'claude_code.token.usage' AND attr_type = 'cacheCreation'
          ), 0)::bigint AS tokens_cache_create,
          coalesce(sum(value) FILTER (
            WHERE metric_name = 'claude_code.cost.usage'
          ), 0)::numeric(12,4) AS cost_usd,
          coalesce(sum(value) FILTER (
            WHERE metric_name = 'claude_code.active_time.total'
          ), 0)::bigint AS active_seconds
        FROM telemetry_metrics
        WHERE occurred_at >= now() - interval '48 hours'
        GROUP BY 1, 2, 3
      )
      INSERT INTO telemetry_daily_user_project AS d (
        day, user_id, project_path,
        sessions, tokens_input, tokens_output, tokens_cache_read,
        tokens_cache_create, cost_usd, active_seconds
      )
      SELECT day, user_id, project_path,
             sessions::int, tokens_input, tokens_output, tokens_cache_read,
             tokens_cache_create, cost_usd, active_seconds
      FROM source
      ON CONFLICT (day, user_id, project_path) DO UPDATE SET
        sessions = EXCLUDED.sessions,
        tokens_input = EXCLUDED.tokens_input,
        tokens_output = EXCLUDED.tokens_output,
        tokens_cache_read = EXCLUDED.tokens_cache_read,
        tokens_cache_create = EXCLUDED.tokens_cache_create,
        cost_usd = EXCLUDED.cost_usd,
        active_seconds = EXCLUDED.active_seconds
    `);
  }

  async pruneOldData() {
    await this.pool.query(
      `DELETE FROM telemetry_metrics WHERE occurred_at < now() - $1::int * interval '1 day'`,
      [RETENTION_DAYS]
    );
    await this.pool.query(
      `DELETE FROM telemetry_events WHERE occurred_at < now() - $1::int * interval '1 day'`,
      [RETENTION_DAYS]
    );
  }

  // ─────────── Queries pro dashboard ───────────

  async getProjectsList(teamId: string): Promise<TelemetryProjectsListItem[]> {
    const result = await this.pool.query<{
      project_path: string;
      last_seen_at: Date;
      unique_users: string;
    }>(
      `
        SELECT m.project_path,
               max(m.occurred_at) AS last_seen_at,
               count(DISTINCT m.user_id)::text AS unique_users
        FROM telemetry_metrics m
        JOIN team_members tm ON tm.user_id = m.user_id
        WHERE tm.team_id = $1
          AND m.project_path IS NOT NULL
          AND m.project_path <> ''
        GROUP BY m.project_path
        ORDER BY last_seen_at DESC
        LIMIT 200
      `,
      [teamId]
    );
    return result.rows.map((row) => ({
      projectPath: row.project_path,
      lastSeenAt: row.last_seen_at.toISOString(),
      uniqueUsers: Number(row.unique_users)
    }));
  }

  async getOverview(teamId: string, filters: TelemetryFilters): Promise<TelemetryOverview> {
    const from = clampDate(filters.from);
    const to = clampDate(filters.to);
    const projectFilter = filters.projectPath?.trim() || null;
    const userFilter = filters.userId?.trim() || null;

    const [totals, dailyTeam, perUser, perProject, modelMix, topSkills, topPlugins, costPerDev] =
      await Promise.all([
        this.queryTotals(teamId, from, to, projectFilter, userFilter),
        this.queryDailyTeam(teamId, from, to, projectFilter, userFilter),
        this.queryPerUser(teamId, from, to, projectFilter, userFilter),
        this.queryPerProject(teamId, from, to, userFilter),
        this.queryModelMix(teamId, from, to, projectFilter, userFilter),
        this.queryTopEventKey(teamId, from, to, projectFilter, userFilter, "skill_name"),
        this.queryTopEventKey(teamId, from, to, projectFilter, userFilter, "plugin_name"),
        this.queryCostPerDev(teamId, from, to, projectFilter, userFilter)
      ]);

    return {
      filters: {
        from: from.toISOString(),
        to: to.toISOString(),
        projectPath: projectFilter ?? undefined,
        userId: userFilter ?? undefined
      },
      totals,
      dailyTeam,
      perUser,
      perProject,
      modelMix,
      topSkills,
      topPlugins,
      costPerDevPerDay: costPerDev
    };
  }

  private async queryTotals(
    teamId: string,
    from: Date,
    to: Date,
    projectFilter: string | null,
    userFilter: string | null
  ): Promise<TelemetryTotals> {
    const result = await this.pool.query<{
      sessions: string;
      tokens_input: string;
      tokens_output: string;
      tokens_cache_read: string;
      tokens_cache_create: string;
      cost_usd: string;
      active_seconds: string;
    }>(
      `
        SELECT
          coalesce(sum(d.sessions), 0)::text AS sessions,
          coalesce(sum(d.tokens_input), 0)::text AS tokens_input,
          coalesce(sum(d.tokens_output), 0)::text AS tokens_output,
          coalesce(sum(d.tokens_cache_read), 0)::text AS tokens_cache_read,
          coalesce(sum(d.tokens_cache_create), 0)::text AS tokens_cache_create,
          coalesce(sum(d.cost_usd), 0)::text AS cost_usd,
          coalesce(sum(d.active_seconds), 0)::text AS active_seconds
        FROM telemetry_daily_user_project d
        JOIN team_members tm ON tm.user_id = d.user_id
        WHERE tm.team_id = $1
          AND d.day BETWEEN $2::date AND $3::date
          AND ($4::text IS NULL OR d.project_path = $4)
          AND ($5::text IS NULL OR d.user_id = $5)
      `,
      [teamId, from, to, projectFilter, userFilter]
    );
    const row = result.rows[0] ?? {
      sessions: "0",
      tokens_input: "0",
      tokens_output: "0",
      tokens_cache_read: "0",
      tokens_cache_create: "0",
      cost_usd: "0",
      active_seconds: "0"
    };
    const input = Number(row.tokens_input);
    const cacheRead = Number(row.tokens_cache_read);
    return {
      sessions: Number(row.sessions),
      tokensInput: input,
      tokensOutput: Number(row.tokens_output),
      tokensCacheRead: cacheRead,
      tokensCacheCreate: Number(row.tokens_cache_create),
      costUsd: Number(row.cost_usd),
      activeSeconds: Number(row.active_seconds),
      cacheHitRatio: input + cacheRead === 0 ? 0 : cacheRead / (input + cacheRead)
    };
  }

  private async queryDailyTeam(
    teamId: string,
    from: Date,
    to: Date,
    projectFilter: string | null,
    userFilter: string | null
  ): Promise<TelemetryDailyTeamPoint[]> {
    const result = await this.pool.query<{
      day: Date;
      sessions: string;
      tokens_total: string;
      cost_usd: string;
    }>(
      `
        SELECT d.day,
               coalesce(sum(d.sessions), 0)::text AS sessions,
               coalesce(sum(d.tokens_input + d.tokens_output + d.tokens_cache_read + d.tokens_cache_create), 0)::text AS tokens_total,
               coalesce(sum(d.cost_usd), 0)::text AS cost_usd
        FROM telemetry_daily_user_project d
        JOIN team_members tm ON tm.user_id = d.user_id
        WHERE tm.team_id = $1
          AND d.day BETWEEN $2::date AND $3::date
          AND ($4::text IS NULL OR d.project_path = $4)
          AND ($5::text IS NULL OR d.user_id = $5)
        GROUP BY d.day
        ORDER BY d.day ASC
      `,
      [teamId, from, to, projectFilter, userFilter]
    );
    return result.rows.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      sessions: Number(row.sessions),
      tokensTotal: Number(row.tokens_total),
      costUsd: Number(row.cost_usd)
    }));
  }

  private async queryPerUser(
    teamId: string,
    from: Date,
    to: Date,
    projectFilter: string | null,
    userFilter: string | null
  ): Promise<TelemetryUserAggregate[]> {
    const result = await this.pool.query<{
      user_id: string;
      email: string;
      sessions: string;
      tokens_input: string;
      tokens_output: string;
      tokens_cache_read: string;
      tokens_cache_create: string;
      cost_usd: string;
      active_seconds: string;
      last_seen_at: Date | null;
    }>(
      `
        SELECT u.id AS user_id,
               u.email,
               coalesce(sum(d.sessions), 0)::text AS sessions,
               coalesce(sum(d.tokens_input), 0)::text AS tokens_input,
               coalesce(sum(d.tokens_output), 0)::text AS tokens_output,
               coalesce(sum(d.tokens_cache_read), 0)::text AS tokens_cache_read,
               coalesce(sum(d.tokens_cache_create), 0)::text AS tokens_cache_create,
               coalesce(sum(d.cost_usd), 0)::text AS cost_usd,
               coalesce(sum(d.active_seconds), 0)::text AS active_seconds,
               (SELECT max(last_seen_at) FROM paired_devices WHERE user_id = u.id) AS last_seen_at
        FROM team_members m
        JOIN hub_users u ON u.id = m.user_id
        LEFT JOIN telemetry_daily_user_project d
          ON d.user_id = u.id
         AND d.day BETWEEN $2::date AND $3::date
         AND ($4::text IS NULL OR d.project_path = $4)
        WHERE m.team_id = $1
          AND ($5::text IS NULL OR u.id = $5)
        GROUP BY u.id, u.email
        ORDER BY cost_usd DESC NULLS LAST
      `,
      [teamId, from, to, projectFilter, userFilter]
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      userEmail: row.email,
      sessions: Number(row.sessions),
      tokensInput: Number(row.tokens_input),
      tokensOutput: Number(row.tokens_output),
      tokensCacheRead: Number(row.tokens_cache_read),
      tokensCacheCreate: Number(row.tokens_cache_create),
      costUsd: Number(row.cost_usd),
      activeSeconds: Number(row.active_seconds),
      lastSeenAt: row.last_seen_at?.toISOString()
    }));
  }

  private async queryPerProject(
    teamId: string,
    from: Date,
    to: Date,
    userFilter: string | null
  ): Promise<TelemetryProjectAggregate[]> {
    const result = await this.pool.query<{
      project_path: string;
      tokens: string;
      cost_usd: string;
      sessions: string;
    }>(
      `
        SELECT d.project_path,
               coalesce(sum(d.tokens_input + d.tokens_output + d.tokens_cache_read + d.tokens_cache_create), 0)::text AS tokens,
               coalesce(sum(d.cost_usd), 0)::text AS cost_usd,
               coalesce(sum(d.sessions), 0)::text AS sessions
        FROM telemetry_daily_user_project d
        JOIN team_members tm ON tm.user_id = d.user_id
        WHERE tm.team_id = $1
          AND d.day BETWEEN $2::date AND $3::date
          AND ($4::text IS NULL OR d.user_id = $4)
        GROUP BY d.project_path
        ORDER BY tokens DESC
        LIMIT 15
      `,
      [teamId, from, to, userFilter]
    );
    return result.rows.map((row) => ({
      projectPath: row.project_path,
      tokens: Number(row.tokens),
      costUsd: Number(row.cost_usd),
      sessions: Number(row.sessions)
    }));
  }

  private async queryModelMix(
    teamId: string,
    from: Date,
    to: Date,
    projectFilter: string | null,
    userFilter: string | null
  ): Promise<TelemetryModelMixRow[]> {
    const result = await this.pool.query<{ user_id: string; model: string; tokens: string }>(
      `
        SELECT m.user_id, m.model, coalesce(sum(m.value), 0)::text AS tokens
        FROM telemetry_metrics m
        JOIN team_members tm ON tm.user_id = m.user_id
        WHERE tm.team_id = $1
          AND m.metric_name = 'claude_code.token.usage'
          AND m.attr_type IN ('input','output')
          AND m.occurred_at BETWEEN $2::timestamptz AND $3::timestamptz
          AND m.model IS NOT NULL
          AND ($4::text IS NULL OR m.project_path = $4)
          AND ($5::text IS NULL OR m.user_id = $5)
        GROUP BY m.user_id, m.model
        ORDER BY tokens DESC
      `,
      [teamId, from, to, projectFilter, userFilter]
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      model: row.model,
      tokens: Number(row.tokens)
    }));
  }

  private async queryTopEventKey(
    teamId: string,
    from: Date,
    to: Date,
    projectFilter: string | null,
    userFilter: string | null,
    column: "skill_name" | "plugin_name"
  ): Promise<TelemetryBreakdownItem[]> {
    const eventName = column === "skill_name" ? "claude_code.skill_activated" : "claude_code.plugin_loaded";
    const result = await this.pool.query<{ key: string; value: string }>(
      `
        SELECT e.${column} AS key, count(*)::text AS value
        FROM telemetry_events e
        JOIN team_members tm ON tm.user_id = e.user_id
        WHERE tm.team_id = $1
          AND e.event_name = $2
          AND e.${column} IS NOT NULL
          AND e.occurred_at BETWEEN $3::timestamptz AND $4::timestamptz
          AND ($5::text IS NULL OR e.project_path = $5)
          AND ($6::text IS NULL OR e.user_id = $6)
        GROUP BY e.${column}
        ORDER BY count(*) DESC
        LIMIT 10
      `,
      [teamId, eventName, from, to, projectFilter, userFilter]
    );
    return result.rows.map((row) => ({ key: row.key, value: Number(row.value) }));
  }

  private async queryCostPerDev(
    teamId: string,
    from: Date,
    to: Date,
    projectFilter: string | null,
    userFilter: string | null
  ): Promise<TelemetryCostPerDevPoint[]> {
    const result = await this.pool.query<{
      day: Date;
      cost: string;
      active_devs: string;
    }>(
      `
        SELECT d.day,
               coalesce(sum(d.cost_usd), 0)::text AS cost,
               count(DISTINCT d.user_id)::text AS active_devs
        FROM telemetry_daily_user_project d
        JOIN team_members tm ON tm.user_id = d.user_id
        WHERE tm.team_id = $1
          AND d.day BETWEEN $2::date AND $3::date
          AND ($4::text IS NULL OR d.project_path = $4)
          AND ($5::text IS NULL OR d.user_id = $5)
          AND d.cost_usd > 0
        GROUP BY d.day
        ORDER BY d.day ASC
      `,
      [teamId, from, to, projectFilter, userFilter]
    );
    return result.rows.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      cost: Number(row.cost),
      activeDevs: Number(row.active_devs)
    }));
  }
}

function buildRowFromMetric(metric: {
  name: string;
  value: number;
  timestampMs: number;
  attributes: Record<string, string>;
  resource: Record<string, string>;
}): IngestRow {
  const attrs = { ...metric.resource, ...metric.attributes };
  return {
    occurredAt: new Date(metric.timestampMs),
    metricName: metric.name,
    value: Number.isFinite(metric.value) ? metric.value : 0,
    sessionId: attrs["session.id"] ?? null,
    model: attrs["model"] ?? null,
    attrType: attrs["type"] ?? null,
    terminalType: attrs["terminal.type"] ?? null,
    projectPath: attrs["project.path"] ?? attrs["cwd"] ?? null,
    skillName: null,
    pluginName: null,
    marketplaceName: null,
    attributes: attrs
  };
}

function buildRowFromEvent(event: {
  name: string;
  timestampMs: number;
  attributes: Record<string, string>;
  resource: Record<string, string>;
}): IngestRow {
  const attrs = { ...event.resource, ...event.attributes };
  return {
    occurredAt: new Date(event.timestampMs),
    eventName: event.name,
    sessionId: attrs["session.id"] ?? null,
    model: null,
    attrType: null,
    terminalType: null,
    projectPath: attrs["project.path"] ?? attrs["cwd"] ?? null,
    skillName: attrs["skill.name"] ?? null,
    pluginName: attrs["plugin.name"] ?? null,
    marketplaceName: attrs["marketplace.name"] ?? null,
    attributes: attrs
  };
}

function clampDate(input: string): Date {
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}
