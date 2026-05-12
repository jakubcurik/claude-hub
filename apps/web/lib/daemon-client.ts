import type {
  AssetDiff,
  CatalogAsset,
  DaemonHello,
  InstallPreview,
  LocalAsset,
  LocalAssetExport,
  LocalAssetState
} from "@claude-hub/schema";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:17373";
const DEFAULT_TIMEOUT_MS = 10_000;

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(token: string, baseUrl = DEFAULT_DAEMON_URL) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async hello(): Promise<DaemonHello> {
    return this.request<DaemonHello>("/v1/hello", { auth: false });
  }

  async state(catalog: CatalogAsset[]): Promise<LocalAssetState[]> {
    const response = await this.request<{ state: LocalAssetState[] }>("/v1/state", {
      method: "POST",
      body: { catalog }
    });
    return response.state;
  }

  async installPreview(asset: CatalogAsset): Promise<InstallPreview> {
    return this.request<InstallPreview>("/v1/install-preview", {
      method: "POST",
      body: { asset }
    });
  }

  async install(asset: CatalogAsset): Promise<LocalAssetState> {
    const response = await this.request<{ state: LocalAssetState }>("/v1/install", {
      method: "POST",
      body: { asset }
    });
    return response.state;
  }

  async uninstall(asset: CatalogAsset): Promise<LocalAssetState> {
    const response = await this.request<{ state: LocalAssetState }>("/v1/uninstall", {
      method: "POST",
      body: { asset }
    });
    return response.state;
  }

  async diff(asset: CatalogAsset): Promise<AssetDiff> {
    return this.request<AssetDiff>("/v1/diff", {
      method: "POST",
      body: { asset }
    });
  }

  async setEnabled(asset: CatalogAsset, enabled: boolean): Promise<LocalAssetState> {
    const response = await this.request<{ state: LocalAssetState }>("/v1/set-enabled", {
      method: "POST",
      body: { asset, enabled }
    });
    return response.state;
  }

  async localAssets(): Promise<LocalAsset[]> {
    const response = await this.request<{ assets: LocalAsset[] }>("/v1/local-assets");
    return response.assets;
  }

  async exportLocalAsset(localAssetId: string): Promise<LocalAssetExport> {
    const response = await this.request<{ asset: LocalAssetExport }>("/v1/local-assets/export", {
      method: "POST",
      body: { localAssetId }
    });
    return response.asset;
  }

  private async request<T>(
    path: string,
    options: {
      auth?: boolean;
      body?: unknown;
      method?: "GET" | "POST";
      timeoutMs?: number;
    } = {}
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          "content-type": "application/json",
          ...(options.auth === false ? {} : { authorization: `Bearer ${this.token}` })
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Lokální služba neodpověděla včas. Obnovte stránku nebo zkuste zařízení znovu spárovat.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }

    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(payload.message || payload.error || "Požadavek na lokální službu selhal.");
    }

    return payload as T;
  }
}
