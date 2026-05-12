import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import type { CatalogAsset } from "@claude-hub/schema";
import { RegistryRepository } from "./repository.js";

const databaseUrl = process.env.CLAUDE_HUB_TEST_DATABASE_URL ?? process.env.CLAUDE_HUB_DATABASE_URL;

if (!databaseUrl) {
  test("Postgres catalog repository", { skip: "Set CLAUDE_HUB_TEST_DATABASE_URL to run this integration test." }, () => {});
} else {
  test("publishes, reloads, and upserts catalog assets in Postgres", async () => {
    const teamId = `test-${randomUUID()}`;
    const pool = new Pool({ connectionString: databaseUrl });
    const repository = new RegistryRepository({ pool });

    try {
      await repository.init();

      const firstAsset = makeAsset("0.1.0", "První verze");
      await repository.publishAsset(teamId, firstAsset);

      const firstCatalog = await repository.getCatalog(teamId);
      assert.equal(firstCatalog.length, 1);
      assert.equal(firstCatalog[0]?.summary, "První verze");

      const restartedRepository = new RegistryRepository({ pool });
      const reloadedCatalog = await restartedRepository.getCatalog(teamId);
      assert.equal(reloadedCatalog.length, 1);
      assert.equal(reloadedCatalog[0]?.slug, "sample-skill");

      const updatedAsset = makeAsset("0.2.0", "Aktualizovaná verze");
      await repository.publishAsset(teamId, updatedAsset);

      const updatedCatalog = await repository.getCatalog(teamId);
      assert.equal(updatedCatalog.length, 1);
      assert.equal(updatedCatalog[0]?.version, "0.2.0");
      assert.equal(updatedCatalog[0]?.summary, "Aktualizovaná verze");
    } finally {
      await pool.query("DELETE FROM catalog_assets WHERE team_id = $1", [teamId]).catch(() => undefined);
      await pool.end();
    }
  });
}

function makeAsset(version: string, summary: string): CatalogAsset {
  return {
    id: "skill:sample-skill",
    type: "skill",
    slug: "sample-skill",
    name: "Sample Skill",
    summary,
    description: "Testovací skill pro katalog.",
    owner: {
      id: "local-user",
      name: "Lokální uživatel"
    },
    version,
    risk: "low",
    tags: ["skill"],
    usedBy: 0,
    updatedAt: new Date().toISOString(),
    compatibility: {
      daemon: "0.1.0",
      platforms: ["darwin", "linux", "windows"]
    },
    permissions: [
      {
        label: "Nízké riziko",
        description: "Pouze textová položka.",
        level: "low"
      }
    ],
    requiredEnv: [],
    files: [
      {
        path: "SKILL.md",
        content: "# Sample Skill\n\nTest."
      }
    ]
  };
}
