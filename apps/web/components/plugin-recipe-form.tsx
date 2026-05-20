"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { CatalogAsset } from "@claude-hub/schema";
import { publishPluginRecipe } from "@/app/actions";

type SourceType = "github" | "url" | "git-subdir" | "npm";

interface PluginRecipeFormProps {
  // Volitelně předvyplněné hodnoty z lokálního pluginu (např. když UI ví
  // marketplace URL z installed_plugins.json).
  defaults?: Partial<{
    marketplaceName: string;
    pluginName: string;
    marketplaceUrl: string;
    setupCommand: string;
  }>;
  onClose: () => void;
  onPublished: (asset: CatalogAsset) => void;
}

/**
 * Form pro publikaci plugin recipe (marketplace pointer) do katalogu Hubu.
 * Recipe popisuje, kde najít plugin (marketplace source) — Hub neukládá
 * samotné soubory pluginu. Příjemci recipe se plugin nainstaluje tím, že daemon
 * naklonuje marketplace repo a JSON-patchuje ~/.claude/settings.json.
 *
 * Sensitive credentials (PAT, OAuth tokeny) form NIKDY nepřijímá — Hub je
 * nesdílí. Recipe může obsahovat jen non-sensitive defaultOptions (např.
 * region, default scope).
 */
export function PluginRecipeForm({ defaults, onClose, onPublished }: PluginRecipeFormProps) {
  const [sourceType, setSourceType] = useState<SourceType>("github");
  const [marketplaceName, setMarketplaceName] = useState(defaults?.marketplaceName ?? "");
  const [pluginName, setPluginName] = useState(defaults?.pluginName ?? "");
  const [githubRepo, setGithubRepo] = useState("");
  const [gitUrl, setGitUrl] = useState(defaults?.marketplaceUrl ?? "");
  const [gitSubdirPath, setGitSubdirPath] = useState("");
  const [npmPackage, setNpmPackage] = useState("");
  const [ref, setRef] = useState("");
  const [setupCommand, setSetupCommand] = useState(defaults?.setupCommand ?? "");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [defaultOptions, setDefaultOptions] = useState("{}");
  const [displayName, setDisplayName] = useState("");
  const [summary, setSummary] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildSource(): Record<string, unknown> | null {
    switch (sourceType) {
      case "github":
        if (!githubRepo.trim()) {
          setError("Vyplň GitHub repo ve tvaru owner/repo.");
          return null;
        }
        return { source: "github", repo: githubRepo.trim(), ...(ref ? { ref } : {}) };
      case "url":
        if (!gitUrl.trim()) {
          setError("Vyplň git URL marketplace repa.");
          return null;
        }
        return { source: "url", url: gitUrl.trim(), ...(ref ? { ref } : {}) };
      case "git-subdir":
        if (!gitUrl.trim() || !gitSubdirPath.trim()) {
          setError("Vyplň git URL i subdir cestu.");
          return null;
        }
        return {
          source: "git-subdir",
          url: gitUrl.trim(),
          path: gitSubdirPath.trim(),
          ...(ref ? { ref } : {})
        };
      case "npm":
        if (!npmPackage.trim()) {
          setError("Vyplň npm package name.");
          return null;
        }
        return { source: "npm", package: npmPackage.trim(), ...(ref ? { version: ref } : {}) };
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!marketplaceName.trim() || !pluginName.trim() || !displayName.trim() || !summary.trim()) {
      setError("Vyplň marketplace, plugin name, display name a krátký popis.");
      return;
    }
    const marketplaceSource = buildSource();
    if (!marketplaceSource) return;

    let parsedDefaults: Record<string, string | number | boolean> = {};
    if (defaultOptions.trim() && defaultOptions.trim() !== "{}") {
      try {
        const parsed = JSON.parse(defaultOptions);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("defaultOptions musí být objekt.");
        }
        parsedDefaults = parsed;
      } catch (err) {
        setError(`defaultOptions není validní JSON objekt: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const slug = `${marketplaceName.trim()}-${pluginName.trim()}`;
      const asset = await publishPluginRecipe({
        slug,
        name: displayName.trim(),
        summary: summary.trim(),
        version: version.trim() || "0.1.0",
        risk: "high",
        recipe: {
          marketplaceName: marketplaceName.trim(),
          marketplaceSource,
          pluginName: pluginName.trim(),
          ...(Object.keys(parsedDefaults).length > 0 ? { defaultOptions: parsedDefaults } : {}),
          autoUpdate,
          ...(setupCommand.trim() ? { setupCommand: setupCommand.trim() } : {})
        }
      });
      onPublished(asset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publikace selhala.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal large" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Sdílet plugin recipe</h2>
          <button type="button" onClick={onClose} aria-label="Zavřít">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          <p>
            Recipe je odkaz na marketplace, ze kterého daemon plugin naklonuje. Senzitivní credentials
            (OAuth tokeny, API klíče) se přes Hub <strong>nesdílí</strong> — každý uživatel je
            získá přes setup wizard pluginu.
          </p>
          <form onSubmit={handleSubmit}>
            <label>
              <span>Marketplace name</span>
              <input
                type="text"
                value={marketplaceName}
                onChange={(e) => setMarketplaceName(e.target.value)}
                placeholder="např. animato"
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                required
              />
            </label>
            <label>
              <span>Plugin name</span>
              <input
                type="text"
                value={pluginName}
                onChange={(e) => setPluginName(e.target.value)}
                placeholder="např. animato-mcp"
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                required
              />
            </label>
            <fieldset>
              <legend>Marketplace source</legend>
              {(["github", "url", "git-subdir", "npm"] as const).map((opt) => (
                <label key={opt} className="radio-row">
                  <input
                    type="radio"
                    name="source-type"
                    checked={sourceType === opt}
                    onChange={() => setSourceType(opt)}
                  />
                  {opt}
                </label>
              ))}
              {sourceType === "github" ? (
                <label>
                  <span>GitHub repo</span>
                  <input
                    type="text"
                    value={githubRepo}
                    onChange={(e) => setGithubRepo(e.target.value)}
                    placeholder="owner/repo"
                  />
                </label>
              ) : null}
              {(sourceType === "url" || sourceType === "git-subdir") ? (
                <label>
                  <span>Git URL</span>
                  <input
                    type="url"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    placeholder="https://gitlab.example.com/team/marketplace.git"
                  />
                </label>
              ) : null}
              {sourceType === "git-subdir" ? (
                <label>
                  <span>Subdir cesta</span>
                  <input
                    type="text"
                    value={gitSubdirPath}
                    onChange={(e) => setGitSubdirPath(e.target.value)}
                    placeholder="tools/plugin"
                  />
                </label>
              ) : null}
              {sourceType === "npm" ? (
                <label>
                  <span>npm package</span>
                  <input
                    type="text"
                    value={npmPackage}
                    onChange={(e) => setNpmPackage(e.target.value)}
                    placeholder="@org/claude-plugin"
                  />
                </label>
              ) : null}
              <label>
                <span>Branch / tag / SHA (volitelně)</span>
                <input
                  type="text"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="main, v1.2.3, ..."
                />
              </label>
            </fieldset>
            <label>
              <span>Display name (zobrazí se v katalogu)</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </label>
            <label>
              <span>Krátký popis</span>
              <input
                type="text"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                required
              />
            </label>
            <label>
              <span>Verze</span>
              <input
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
            </label>
            <label>
              <span>Setup command (volitelně)</span>
              <input
                type="text"
                value={setupCommand}
                onChange={(e) => setSetupCommand(e.target.value)}
                placeholder="/animato-mcp:setup"
              />
            </label>
            <label>
              <span>Default options (JSON, jen non-sensitive)</span>
              <textarea
                value={defaultOptions}
                onChange={(e) => setDefaultOptions(e.target.value)}
                rows={3}
                placeholder='{"region": "eu-west"}'
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={autoUpdate}
                onChange={(e) => setAutoUpdate(e.target.checked)}
              />
              Auto-update marketplace (denní git pull)
            </label>
            {error ? (
              <p className="error-message" role="alert">
                {error}
              </p>
            ) : null}
            <footer>
              <button type="button" onClick={onClose} disabled={submitting}>
                Zrušit
              </button>
              <button type="submit" disabled={submitting}>
                {submitting ? "Publikuji..." : "Publikovat recipe"}
              </button>
            </footer>
          </form>
        </div>
      </div>
    </div>
  );
}
