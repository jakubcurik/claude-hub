"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Copy,
  Download,
  FileText,
  FolderUp,
  MonitorCheck,
  PlugZap,
  RefreshCw,
  Search,
  ToggleLeft,
  ToggleRight,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetType,
  CatalogAsset,
  InstallOperation,
  InstallPreview,
  LocalAsset,
  LocalAssetState,
  RiskLevel
} from "@claude-hub/schema";
import { logoutAction, publishLocalAssetToCatalog, registerPairedDevice } from "@/app/actions";
import { DaemonClient } from "@/lib/daemon-client";

type View = "catalog" | "local";
type Filter = "all" | AssetType;

interface CatalogExperienceProps {
  daemonInstall: DaemonInstallConfig;
  initialAssets: CatalogAsset[];
  userEmail: string;
}

interface DaemonInstallConfig {
  brewPackage: string;
  hubUrl: string;
  wingetId: string;
}

interface ModalState {
  title: string;
  intro: string;
  confirmLabel: string;
  operations: InstallOperation[];
  warnings: string[];
  requiredEnv?: string[];
  onConfirm: () => Promise<void>;
}

const tokenStorageKey = "claudeHubDaemonToken";
const daemonOrigin = "http://127.0.0.1:17373";

const navItems: Array<{ id: View; label: string }> = [
  { id: "catalog", label: "Katalog" },
  { id: "local", label: "Tento počítač" }
];

const filters: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Vše" },
  { id: "skill", label: "Skilly" },
  { id: "command", label: "Příkazy" },
  { id: "mcp", label: "MCP" },
  { id: "hook", label: "Hooky" },
  { id: "plugin", label: "Pluginy" },
  { id: "config", label: "Nastavení" }
];

const typeLabels: Record<AssetType, string> = {
  skill: "Skill",
  command: "Příkaz",
  mcp: "MCP",
  hook: "Hook",
  plugin: "Plugin",
  config: "Nastavení"
};

const riskLabels: Record<RiskLevel, string> = {
  low: "nízké",
  medium: "střední",
  high: "vysoké",
  restricted: "omezené"
};

const operationLabels: Record<InstallOperation["type"], string> = {
  create: "Vytvořit",
  replace: "Nahradit",
  backup: "Zálohovat",
  manifest: "Uložit metadata",
  enable: "Zapnout",
  disable: "Vypnout"
};

function readInitialToken() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(tokenStorageKey) ?? "";
}

function formatState(state?: LocalAssetState, connected = false, assetType?: CatalogAsset["type"]) {
  if (assetType && !["skill", "command"].includes(assetType)) {
    return { label: "Zatím jen v katalogu", tone: "planned" };
  }

  if (!connected) {
    return { label: "Počítač není připojený", tone: "offline" };
  }

  if (!state?.installed) {
    return { label: "Nenainstalováno", tone: "neutral" };
  }

  if (state.localChanges) {
    return { label: "Upraveno lokálně", tone: "warning" };
  }

  if (state.updateAvailable) {
    return { label: "Nová verze", tone: "update" };
  }

  return state.enabled
    ? { label: "Zapnuto", tone: "enabled" }
    : { label: "Vypnuto", tone: "disabled" };
}

export function CatalogExperience({ daemonInstall, initialAssets, userEmail }: CatalogExperienceProps) {
  const [activeView, setActiveView] = useState<View>("catalog");
  const [catalogFilter, setCatalogFilter] = useState<Filter>("all");
  const [localFilter, setLocalFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [token, setToken] = useState(readInitialToken);
  const [savedToken, setSavedToken] = useState(readInitialToken);
  const [daemonSummary, setDaemonSummary] = useState("Lokální služba zatím nebyla zkontrolována.");
  const [isConnected, setIsConnected] = useState(false);
  const [states, setStates] = useState<Record<string, LocalAssetState>>({});
  const [localAssets, setLocalAssets] = useState<LocalAsset[]>([]);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [manualPairingOpen, setManualPairingOpen] = useState(false);
  const lastAutoRefreshKey = useRef("");

  const normalizedToken = savedToken.trim();
  const client = useMemo(() => new DaemonClient(normalizedToken), [normalizedToken]);
  const catalogRefreshKey = useMemo(() => initialAssets.map((asset) => asset.id).join("\n"), [initialAssets]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const refresh = useCallback(async (tokenOverride?: string) => {
    const activeToken = tokenOverride ?? normalizedToken;
    const activeClient = tokenOverride === undefined ? client : new DaemonClient(activeToken);

    setBusy(true);
    try {
      const hello = await activeClient.hello();
      if (!activeToken) {
        setIsConnected(false);
        setDaemonSummary(`Služba běží v ${hello.claudeHome}. Pro zobrazení stavu ji spárujte.`);
        return;
      }

      const [nextStates, nextLocalAssets] = await Promise.all([
        activeClient.state(initialAssets),
        activeClient.localAssets()
      ]);

      void registerPairedDevice({
        tokenHash: await sha256(activeToken),
        label: deviceLabel(hello.claudeHome),
        claudeHome: hello.claudeHome
      }).catch(() => undefined);

      setStates(Object.fromEntries(nextStates.map((item) => [item.assetId, item])));
      setLocalAssets(nextLocalAssets.map(normalizeLocalAsset));
      setIsConnected(true);
      setDaemonSummary(`Připojeno k Claude Code v ${hello.claudeHome}.`);
    } catch (error) {
      setIsConnected(false);
      setStates({});
      setLocalAssets([]);
      setDaemonSummary(error instanceof Error ? error.message : "Lokální služba je nedostupná.");
    } finally {
      setBusy(false);
    }
  }, [client, initialAssets, normalizedToken]);

  useEffect(() => {
    const autoRefreshKey = `${catalogRefreshKey}:${normalizedToken}`;
    if (!normalizedToken || lastAutoRefreshKey.current === autoRefreshKey) {
      return;
    }

    lastAutoRefreshKey.current = autoRefreshKey;
    void refresh();
  }, [catalogRefreshKey, normalizedToken, refresh]);

  const visibleAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return initialAssets.filter((asset) => {
      const matchesFilter = catalogFilter === "all" || asset.type === catalogFilter;
      const searchable = `${asset.name} ${asset.summary} ${asset.description} ${asset.tags.join(" ")}`.toLowerCase();
      return matchesFilter && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [catalogFilter, initialAssets, query]);

  const visibleLocalAssets = useMemo(
    () => localAssets.filter((asset) => localFilter === "all" || asset.type === localFilter),
    [localAssets, localFilter]
  );

  const installedCount = Object.values(states).filter((state) => state.installed).length;
  const updateCount = Object.values(states).filter((state) => state.updateAvailable).length;

  async function saveToken() {
    const nextToken = token.trim();
    setToken(nextToken);
    setSavedToken(nextToken);
    window.localStorage.setItem(tokenStorageKey, nextToken);
    await refresh(nextToken);
  }

  async function pairAutomatically() {
    setBusy(true);
    try {
      await client.hello();
    } catch (error) {
      setBusy(false);
      showToast(error instanceof Error ? error.message : "Lokální služba není dostupná.");
      return;
    }
    setBusy(false);

    const returnUrl = `${window.location.origin}/pair/complete`;
    window.location.href = `${daemonOrigin}/pair?returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  function disconnectDaemon() {
    window.localStorage.removeItem(tokenStorageKey);
    setToken("");
    setSavedToken("");
    setStates({});
    setLocalAssets([]);
    setIsConnected(false);
    setDaemonSummary("Zařízení je odpojené. Pro lokální stav ho znovu spárujte.");
  }

  async function requestInstall(asset: CatalogAsset) {
    const preview = await client.installPreview(asset);

    setModal({
      title: states[asset.id]?.installed ? `Aktualizovat ${asset.name}` : `Nainstalovat ${asset.name}`,
      intro: "Než se cokoli zapíše do Claude Code, zkontrolujte plánované změny v souborech.",
      confirmLabel: states[asset.id]?.installed ? "Použít aktualizaci" : "Nainstalovat",
      operations: preview.operations,
      warnings: preview.warnings,
      requiredEnv: preview.requiredEnv,
      onConfirm: async () => {
        await client.install(asset);
        setModal(null);
        await refresh();
        showToast(`Nainstalováno: ${asset.name}.`);
      }
    });
  }

  async function setEnabled(asset: CatalogAsset, enabled: boolean) {
    await client.setEnabled(asset, enabled);
    await refresh();
    showToast(`${enabled ? "Zapnuto" : "Vypnuto"}: ${asset.name}.`);
  }

  async function requestCatalogUpload(asset: LocalAsset) {
    setBusy(true);
    try {
      const exported = await client.exportLocalAsset(asset.localAssetId);
      setModal({
        title: `Nahrát ${asset.name} do katalogu`,
        intro: "Položka se po potvrzení uloží do týmového katalogu.",
        confirmLabel: "Nahrát do katalogu",
        operations: [
          {
            type: "backup",
            path: asset.path,
            description: "Načíst lokální soubory položky.",
            risk: exported.risk
          },
          {
            type: "manifest",
            path: "Týmový katalog",
            description: "Uložit položku do týmového katalogu.",
            risk: "low"
          }
        ],
        warnings: exported.warnings,
        requiredEnv: exported.requiredEnv,
        onConfirm: async () => {
          const published = await publishLocalAssetToCatalog(exported);
          setModal(null);
          await refresh();
          setActiveView("catalog");
          showToast(`Položka "${published.name}" je v katalogu.`);
        }
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Položku se nepodařilo připravit pro katalog.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">CH</div>
          <div>
            <strong>Claude Hub</strong>
            <span>Katalog pro tým</span>
          </div>
        </div>
        <form action={logoutAction} className="account-block">
          <span>{userEmail}</span>
          <button className="secondary dark" type="submit">
            Odhlásit
          </button>
        </form>

        <nav className="nav-list" aria-label="Hlavní navigace">
          {navItems.map((item) => (
            <button
              className={activeView === item.id ? "active" : ""}
              key={item.id}
              onClick={() => setActiveView(item.id)}
              type="button"
            >
              <span>{item.label}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </nav>

        <section className="daemon-card" aria-label="Připojení lokální služby">
          <div className="daemon-title">
            <MonitorCheck size={17} />
            <strong>Lokální služba</strong>
          </div>
          <p>{daemonSummary}</p>
          <div className="daemon-actions">
            <button className="primary" disabled={busy} onClick={pairAutomatically} type="button">
              <PlugZap size={16} />
              Spárovat
            </button>
            <button className="secondary dark" disabled={busy} onClick={() => refresh()} type="button">
              <RefreshCw size={16} />
              Obnovit stav
            </button>
            <button className="secondary dark" disabled={busy || !normalizedToken} onClick={disconnectDaemon} type="button">
              Odpojit
            </button>
          </div>
          <details className="manual-pairing" open={manualPairingOpen} onToggle={(event) => setManualPairingOpen(event.currentTarget.open)}>
            <summary>Zadat token ručně</summary>
            <label htmlFor="pairing-token">Párovací token</label>
            <input
              autoComplete="off"
              id="pairing-token"
              onChange={(event) => setToken(event.target.value)}
              placeholder="Vložte párovací token"
              spellCheck={false}
              type="password"
              value={token}
            />
            <button className="secondary dark" disabled={busy} onClick={saveToken} type="button">
              Připojit
            </button>
          </details>
        </section>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">Sdílení jen po potvrzení</p>
            <h1>{navItems.find((item) => item.id === activeView)?.label}</h1>
          </div>
          <button className="secondary" onClick={() => setActiveView("local")} type="button">
            <FolderUp size={17} />
            Nahrát z počítače
          </button>
        </header>

        <section className="metrics" aria-label="Stav pracovního prostředí">
          <Metric label="Nainstalováno" value={installedCount} />
          <Metric label="Nové verze" value={updateCount} />
          <Metric label="Lokálně nalezeno" value={localAssets.length} />
        </section>

        {activeView === "catalog" ? (
          <section className="workspace">
            {!isConnected ? (
              <DaemonOnboarding
                busy={busy}
                daemonInstall={daemonInstall}
                onPair={pairAutomatically}
                onRefresh={() => refresh()}
              />
            ) : null}
            <div className="info-panel">
              <strong>Katalog obsahuje položky sdílené týmem.</strong>
              <span>
                Karta ukazuje, zda je daná položka dostupná i na tomto počítači. Instalace a úpravy se provedou
                až po vašem potvrzení.
              </span>
            </div>
            <div className="toolbar">
              <label className="search-box">
                <Search size={17} />
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Hledat v katalogu"
                  type="search"
                  value={query}
                />
              </label>
              <FilterSegments
                activeFilter={catalogFilter}
                ariaLabel="Filtrovat katalog"
                onChange={setCatalogFilter}
              />
            </div>

            <div className="catalog-grid">
              {visibleAssets.length > 0 ? (
                visibleAssets.map((asset) => (
                  <AssetCard
                    asset={asset}
                    connected={isConnected}
                    key={asset.id}
                    onDisable={() => setEnabled(asset, false)}
                    onEnable={() => setEnabled(asset, true)}
                    onInstall={() => requestInstall(asset)}
                    state={states[asset.id]}
                  />
                ))
              ) : (
                <section className="empty-panel catalog-empty">
                  <FolderUp size={38} />
                  <h2>Katalog je prázdný</h2>
                  <p>V části Tento počítač můžete nahrát položku z lokální instalace Claude Code.</p>
                </section>
              )}
            </div>
          </section>
        ) : null}

        {activeView === "local" ? (
          <section className="workspace">
            {!isConnected ? (
              <DaemonOnboarding
                busy={busy}
                daemonInstall={daemonInstall}
                onPair={pairAutomatically}
                onRefresh={() => refresh()}
              />
            ) : null}
            <div className="toolbar">
              <FilterSegments
                activeFilter={localFilter}
                ariaLabel="Filtrovat lokální položky"
                onChange={setLocalFilter}
              />
            </div>
            <ListSection
              emptyDetail="Lokální stav se načítá přes lokální službu. Prohlížeč k souborům nepřistupuje přímo."
              emptyText={localEmptyText(isConnected, localAssets.length, visibleLocalAssets.length)}
              items={visibleLocalAssets.map((asset) => (
                <article className="list-row" key={asset.localAssetId}>
                  <div>
                    <div className="row-title">
                      <TypePill type={asset.type} />
                      <span className={asset.scope === "project" ? "scope-pill project" : "scope-pill user"}>
                        {asset.scope === "project" ? asset.projectName : "Osobní"}
                      </span>
                      <strong>{asset.name}</strong>
                    </div>
                    <p>{asset.projectPath ? `${asset.projectPath} -> ${asset.path}` : asset.path}</p>
                    {asset.warnings.length > 0 ? <WarningLine warnings={asset.warnings} /> : null}
                  </div>
                  <button
                    className="secondary"
                    disabled={!isConnected || busy}
                    onClick={() => requestCatalogUpload(asset)}
                    type="button"
                  >
                    <FolderUp size={16} />
                    Nahrát do katalogu
                  </button>
                </article>
              ))}
            />
          </section>
        ) : null}
      </main>

      {modal ? (
        <InstallModal
          busy={busy}
          modal={modal}
          onClose={() => setModal(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await modal.onConfirm();
            } catch (error) {
              showToast(error instanceof Error ? error.message : "Akce se nepodařila dokončit.");
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      <div className={toast ? "toast visible" : "toast"}>{toast}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function FilterSegments({
  activeFilter,
  ariaLabel,
  onChange
}: {
  activeFilter: Filter;
  ariaLabel: string;
  onChange: (filter: Filter) => void;
}) {
  return (
    <div className="segments" role="group" aria-label={ariaLabel}>
      {filters.map((item) => (
        <button
          className={activeFilter === item.id ? "active" : ""}
          key={item.id}
          onClick={() => onChange(item.id)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function DaemonOnboarding({
  busy,
  daemonInstall,
  onPair,
  onRefresh
}: {
  busy: boolean;
  daemonInstall: DaemonInstallConfig;
  onPair: () => void;
  onRefresh: () => void;
}) {
  const [platform, setPlatform] = useState<InstallPlatform>("windows");
  const [copiedCommand, setCopiedCommand] = useState("");
  const installOptions = useMemo(() => daemonInstallOptions(daemonInstall), [daemonInstall]);
  const selectedOption = installOptions.find((option) => option.platform === platform) ?? installOptions[0];

  useEffect(() => {
    setPlatform(detectInstallPlatform());
  }, []);

  async function copyCommand(command: string) {
    await navigator.clipboard.writeText(command);
    setCopiedCommand(command);
    window.setTimeout(() => setCopiedCommand(""), 2200);
  }

  return (
    <section className="onboarding-panel" aria-label="Připojení lokální služby">
      <div className="onboarding-head">
        <MonitorCheck size={24} />
        <div>
          <h2>Připojte tento počítač</h2>
          <p>Claude Hub používá malou lokální službu, která čte instalaci Claude Code a změny provádí až po vašem potvrzení.</p>
        </div>
      </div>
      <div className="onboarding-steps">
        <div className="onboarding-step">
          <span>1</span>
          <strong>Nainstalujte lokální službu</strong>
          <p>Spusťte doporučený příkaz pro svůj systém. Služba bude komunikovat s Claude Hubem jen přes localhost.</p>
          <div className="install-selector" role="group" aria-label="Vybrat operační systém">
            {installOptions.map((option) => (
              <button
                className={platform === option.platform ? "active" : ""}
                key={option.platform}
                onClick={() => setPlatform(option.platform)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <InstallCommand
            command={selectedOption.primaryCommand}
            copied={copiedCommand === selectedOption.primaryCommand}
            label={selectedOption.primaryLabel}
            onCopy={copyCommand}
          />
          <details className="fallback-install">
            <summary>Alternativní příkaz</summary>
            {selectedOption.fallbackCommands.map((fallback) => (
              <InstallCommand
                command={fallback.command}
                copied={copiedCommand === fallback.command}
                key={fallback.command}
                label={fallback.label}
                onCopy={copyCommand}
              />
            ))}
          </details>
        </div>
        <div className="onboarding-step">
          <span>2</span>
          <strong>Spárujte zařízení</strong>
          <p>Po spuštění služby se otevře lokální stránka pro schválení. Párovací token zůstane na tomto počítači.</p>
          <button className="primary" disabled={busy} onClick={onPair} type="button">
            <PlugZap size={16} />
            Spárovat zařízení
          </button>
        </div>
        <div className="onboarding-step">
          <span>3</span>
          <strong>Načtěte stav</strong>
          <p>Claude Hub zobrazí, co je na tomto počítači skutečně nainstalované.</p>
          <button className="secondary" disabled={busy} onClick={onRefresh} type="button">
            <RefreshCw size={16} />
            Zkontrolovat stav
          </button>
        </div>
      </div>
    </section>
  );
}

type InstallPlatform = "windows" | "macos" | "linux";

interface InstallOption {
  fallbackCommands: Array<{ command: string; label: string }>;
  label: string;
  platform: InstallPlatform;
  primaryCommand: string;
  primaryLabel: string;
}

function InstallCommand({
  command,
  copied,
  label,
  onCopy
}: {
  command: string;
  copied: boolean;
  label: string;
  onCopy: (command: string) => void;
}) {
  return (
    <div className="install-command">
      <span>{label}</span>
      <code>{command}</code>
      <button className="secondary" onClick={() => onCopy(command)} type="button">
        <Copy size={15} />
        {copied ? "Zkopírováno" : "Kopírovat"}
      </button>
    </div>
  );
}

function daemonInstallOptions(config: DaemonInstallConfig): InstallOption[] {
  const hubUrl = config.hubUrl.replace(/\/$/, "");
  return [
    {
      fallbackCommands: [
        {
          command: `irm ${hubUrl}/install/windows.ps1 | iex`,
          label: "Záložní PowerShell příkaz"
        }
      ],
      label: "Windows",
      platform: "windows",
      primaryCommand: `winget install ${config.wingetId}`,
      primaryLabel: "Doporučeno přes winget"
    },
    {
      fallbackCommands: [
        {
          command: `curl -fsSL ${hubUrl}/install/macos.sh | sh`,
          label: "Záložní shell příkaz"
        }
      ],
      label: "macOS",
      platform: "macos",
      primaryCommand: `brew install ${config.brewPackage}`,
      primaryLabel: "Doporučeno přes Homebrew"
    },
    {
      fallbackCommands: [
        {
          command: `curl -fsSL ${hubUrl}/install/linux.sh | sh`,
          label: "Instalace přes shell"
        }
      ],
      label: "Linux",
      platform: "linux",
      primaryCommand: `curl -fsSL ${hubUrl}/install/linux.sh | sh`,
      primaryLabel: "Doporučeno"
    }
  ];
}

function detectInstallPlatform(): InstallPlatform {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("mac")) {
    return "macos";
  }
  if (userAgent.includes("linux")) {
    return "linux";
  }
  return "windows";
}

function AssetCard({
  asset,
  connected,
  onDisable,
  onEnable,
  onInstall,
  state
}: {
  asset: CatalogAsset;
  connected: boolean;
  onDisable: () => void;
  onEnable: () => void;
  onInstall: () => void;
  state?: LocalAssetState;
}) {
  const status = formatState(state, connected, asset.type);
  const supported = asset.type === "skill" || asset.type === "command";

  return (
    <article className="asset-card">
      <div className="card-head">
        <TypePill type={asset.type} />
        <span className={`status ${status.tone}`}>{status.label}</span>
      </div>
      <div>
        <h2>{asset.name}</h2>
        <p>{asset.summary}</p>
      </div>
      <div className="asset-detail">{asset.description}</div>
      <div className="meta-row">
        <span>Verze {asset.version}</span>
        <span>{asset.owner.name}</span>
        <span>Použití v týmu: {asset.usedBy}</span>
      </div>
      <div className="tag-row">
        {asset.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <div className="permission-row">
        {asset.permissions.slice(0, 2).map((permission) => (
          <span className={`risk ${permission.level}`} key={permission.label}>
            {permission.label}
          </span>
        ))}
      </div>
      <div className="card-actions">
        <span className={`risk ${asset.risk}`}>Riziko: {riskLabels[asset.risk]}</span>
        {renderAssetAction({ connected, onDisable, onEnable, onInstall, state, supported })}
      </div>
    </article>
  );
}

function renderAssetAction({
  connected,
  onDisable,
  onEnable,
  onInstall,
  state,
  supported
}: {
  connected: boolean;
  onDisable: () => void;
  onEnable: () => void;
  onInstall: () => void;
  state?: LocalAssetState;
  supported: boolean;
}) {
  if (!supported) {
    return (
      <button className="secondary" disabled type="button">
        <CircleDot size={16} />
        Jen v katalogu
      </button>
    );
  }

  if (!connected) {
    return (
      <button className="secondary" disabled type="button">
        <PlugZap size={16} />
        Spárovat
      </button>
    );
  }

  if (!state?.installed || state.updateAvailable) {
    return (
      <button className="primary" onClick={onInstall} type="button">
        <Download size={16} />
        {state?.updateAvailable ? "Aktualizovat" : "Nainstalovat"}
      </button>
    );
  }

  if (state.enabled) {
    return (
      <button className="secondary" onClick={onDisable} type="button">
        <ToggleRight size={16} />
        Vypnout
      </button>
    );
  }

  return (
    <button className="primary" onClick={onEnable} type="button">
      <ToggleLeft size={16} />
      Zapnout
    </button>
  );
}

function TypePill({ type }: { type: AssetType }) {
  return (
    <span className="type-pill">
      <FileText size={13} />
      {typeLabels[type]}
    </span>
  );
}

function WarningLine({ warnings }: { warnings: string[] }) {
  return (
    <div className="warning-line">
      <AlertTriangle size={15} />
      <span>{warnings.join(" ")}</span>
    </div>
  );
}

function normalizeLocalAsset(asset: LocalAsset): LocalAsset {
  return {
    ...asset,
    warnings: asset.warnings ?? []
  };
}

async function sha256(value: string) {
  const encoded = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deviceLabel(claudeHome: string) {
  const normalized = claudeHome.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || "Lokální zařízení";
}

function localEmptyText(connected: boolean, totalCount: number, visibleCount: number) {
  if (!connected) {
    return "Spárujte tento počítač, aby bylo možné načíst lokální položky.";
  }
  if (totalCount > 0 && visibleCount === 0) {
    return "Filtru neodpovídá žádná lokální položka.";
  }
  return "V uživatelských ani projektových složkách Claude Code nejsou žádné sdílitelné položky.";
}

function ListSection({
  emptyDetail,
  emptyText,
  items
}: {
  emptyDetail: string;
  emptyText: string;
  items: React.ReactNode[];
}) {
  if (items.length === 0) {
    return (
      <section className="empty-panel">
        <FileText size={38} />
        <h2>{emptyText}</h2>
        <p>{emptyDetail}</p>
      </section>
    );
  }

  return <section className="list-panel">{items}</section>;
}

function InstallModal({
  busy,
  modal,
  onClose,
  onConfirm
}: {
  busy: boolean;
  modal: ModalState;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="modal-title" aria-modal="true" className="modal" role="dialog">
        <div className="modal-head">
          <div>
            <h2 id="modal-title">{modal.title}</h2>
            <p>{modal.intro}</p>
          </div>
          <button aria-label="Zavřít dialog" className="icon-button" onClick={onClose} type="button">
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          <div className="operation-list">
            {modal.operations.map((operation) => (
              <div className="operation" key={`${operation.type}-${operation.path}`}>
                <span>{operationLabels[operation.type]}</span>
                <strong>{operation.description}</strong>
                <code>{operation.path}</code>
              </div>
            ))}
          </div>

          {modal.requiredEnv?.length ? (
            <div className="notice warning">
              <strong>Je potřeba nastavit proměnné prostředí</strong>
              <p>{modal.requiredEnv.join(", ")}</p>
            </div>
          ) : null}

          {modal.warnings.length > 0 ? (
            <div className="notice warning">
              <strong>Na co dát pozor před sdílením</strong>
              <ul>
                {modal.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="notice success">
              <CheckCircle2 size={16} />
              Nenašel se token, heslo ani cesta svázaná s konkrétním počítačem.
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary" disabled={busy} onClick={onClose} type="button">
            Zrušit
          </button>
          <button className="primary" disabled={busy} onClick={onConfirm} type="button">
            {modal.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
