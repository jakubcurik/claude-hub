import { createHash } from "node:crypto";
import type { CatalogAsset } from "@claude-hub/schema";

export function computeContentHashServerSide(asset: CatalogAsset): string {
  const canonical = JSON.stringify(
    [...asset.files]
      .map((file) => ({
        path: file.path,
        content: file.content,
        executable: file.executable ?? false
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  );
  return createHash("sha256").update(canonical).digest("hex");
}
