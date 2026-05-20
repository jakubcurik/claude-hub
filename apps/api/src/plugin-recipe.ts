// Validace plugin recipe payloadu na API straně. Mirror Go-side validace v
// apps/daemon/internal/claudecode/pluginrecipe.go.
//
// Pro AssetType "plugin" musí asset.files obsahovat právě jeden soubor s
// path = "recipe.json" a content = JSON-stringified PluginRecipe.

import type { CatalogAsset, PluginRecipe } from "@claude-hub/schema";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/;
// Mirror sensitiveKeyPattern v claudecode/pluginrecipe.go.
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|private[_-]?key|credential/i;
const IP_LITERAL_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-fA-F:]+\]?$/;

export interface RecipeValidationError {
  field: string;
  message: string;
}

export function validatePluginRecipePayload(
  asset: Pick<CatalogAsset, "type" | "files">
): RecipeValidationError | null {
  if (asset.type !== "plugin") {
    return null;
  }
  if (!Array.isArray(asset.files) || asset.files.length !== 1) {
    return { field: "files", message: "Plugin recipe musí obsahovat právě jeden soubor (recipe.json)." };
  }
  if (asset.files[0].path !== "recipe.json") {
    return {
      field: "files[0].path",
      message: `Cesta souboru pluginu musí být "recipe.json", nalezeno "${asset.files[0].path}".`
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(asset.files[0].content);
  } catch (err) {
    return {
      field: "files[0].content",
      message: `recipe.json nelze parsovat: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  return validatePluginRecipeShape(parsed);
}

export function validatePluginRecipeShape(value: unknown): RecipeValidationError | null {
  if (typeof value !== "object" || value === null) {
    return { field: "recipe", message: "Recipe není objekt." };
  }
  const recipe = value as Partial<PluginRecipe> & Record<string, unknown>;

  if (typeof recipe.marketplaceName !== "string" || !SLUG_PATTERN.test(recipe.marketplaceName)) {
    return {
      field: "marketplaceName",
      message: "marketplaceName není validní slug (a-z, 0-9, pomlčky)."
    };
  }
  if (typeof recipe.pluginName !== "string" || !SLUG_PATTERN.test(recipe.pluginName)) {
    return {
      field: "pluginName",
      message: "pluginName není validní slug (a-z, 0-9, pomlčky)."
    };
  }
  if (typeof recipe.marketplaceSource !== "object" || recipe.marketplaceSource === null) {
    return { field: "marketplaceSource", message: "marketplaceSource je povinné pole." };
  }
  const sourceError = validateMarketplaceSource(recipe.marketplaceSource as Record<string, unknown>);
  if (sourceError) {
    return sourceError;
  }

  if (recipe.defaultOptions !== undefined) {
    const optsError = validateDefaultOptions(recipe.defaultOptions);
    if (optsError) {
      return optsError;
    }
  }

  if (recipe.setupCommand !== undefined) {
    if (typeof recipe.setupCommand !== "string" || !recipe.setupCommand.startsWith("/")) {
      return {
        field: "setupCommand",
        message: "setupCommand musí začínat \"/\" (např. /animato-mcp:setup)."
      };
    }
  }

  if (recipe.autoUpdate !== undefined && typeof recipe.autoUpdate !== "boolean") {
    return { field: "autoUpdate", message: "autoUpdate musí být boolean." };
  }

  return null;
}

function validateMarketplaceSource(src: Record<string, unknown>): RecipeValidationError | null {
  const sourceType = src.source;
  if (typeof sourceType !== "string") {
    return { field: "marketplaceSource.source", message: "Chybí pole source." };
  }
  switch (sourceType) {
    case "github":
      if (typeof src.repo !== "string" || !GITHUB_REPO_PATTERN.test(src.repo)) {
        return {
          field: "marketplaceSource.repo",
          message: "github source vyžaduje repo ve tvaru \"owner/repo\"."
        };
      }
      return null;
    case "url":
      return validateGitURL(typeof src.url === "string" ? src.url : "", "marketplaceSource.url");
    case "git-subdir":
      {
        const urlErr = validateGitURL(typeof src.url === "string" ? src.url : "", "marketplaceSource.url");
        if (urlErr) return urlErr;
        if (typeof src.path !== "string" || src.path.includes("..")) {
          return {
            field: "marketplaceSource.path",
            message: "git-subdir path není bezpečná relativní cesta."
          };
        }
        return null;
      }
    case "npm":
      if (typeof src.package !== "string" || !NPM_PACKAGE_PATTERN.test(src.package)) {
        return {
          field: "marketplaceSource.package",
          message: "npm source vyžaduje validní package name."
        };
      }
      return null;
    default:
      return {
        field: "marketplaceSource.source",
        message: `Neznámý source typ "${sourceType}" (povoleno: github, url, git-subdir, npm).`
      };
  }
}

function validateGitURL(raw: string, field: string): RecipeValidationError | null {
  if (!raw) {
    return { field, message: "URL je prázdná." };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { field, message: `URL nelze parsovat: ${raw}` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    return { field, message: `Povolena pouze https:// a ssh:// schémata, nalezeno ${parsed.protocol}` };
  }
  if (IP_LITERAL_PATTERN.test(parsed.hostname)) {
    return { field, message: `IP-literál hostname ${parsed.hostname} není povolen.` };
  }
  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost")) {
    return { field, message: "localhost hostname není povolen." };
  }
  return null;
}

function validateDefaultOptions(value: unknown): RecipeValidationError | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { field: "defaultOptions", message: "defaultOptions musí být objekt." };
  }
  for (const [key, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      return {
        field: `defaultOptions.${key}`,
        message: `Klíč "${key}" vypadá jako sensitive údaj — sensitive credentials nikdy nesdílejte přes Hub.`
      };
    }
    if (
      typeof v !== "string" &&
      typeof v !== "number" &&
      typeof v !== "boolean"
    ) {
      return {
        field: `defaultOptions.${key}`,
        message: "defaultOptions hodnoty musí být string, číslo nebo bool (žádné nested objekty)."
      };
    }
  }
  return null;
}
