"use client";

import {
  AlertTriangle,
  CheckCircle2,
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
  AssetDiff,
  AssetFile,
  AssetType,
  CatalogAsset,
  Collection,
  InstallOperation,
  InstallOptions,
  InstallPreview,
  KnownProject,
  LocalAsset,
  LocalAssetState,
  SigningKey,
  TeamMembership,
  TelemetryUserSettingRow
} from "@claude-hub/schema";
import {
  deleteCollection,
  generateAndRegisterSigningKey,
  listTeamMembers,
  logCatalogEvent,
  publishLocalAssetToCatalog,
  removeTeamMember,
  revokeSigningKey,
  rollbackAssetVersion,
  saveCollection,
  updateMemberRole
} from "@/app/actions";
import { AppSidebar, type SidebarNavItem, type SidebarView } from "@/components/app-sidebar";
import { useDaemon } from "@/lib/daemon-context";
import { OwnerSettings } from "@/components/analytics/owner-settings";

type View = SidebarView;
type Filter = "all" | AssetType;

interface CatalogExperienceProps {
  collections: Collection[];
  daemonInstall: DaemonInstallConfig;
  initialAssets: CatalogAsset[];
  members: TeamMembership[];
  membership: TeamMembership;
  signingKeys: SigningKey[];
  userEmail: string;
  userId: string;
  teamName: string;
  /** Initial view dle ?view= URL parametru (např. když přijdeme z /analytics). */
  initialView?: View;
  /** Initial seznam nastavení telemetrie pro owner sekci v Tým view. Bez tohoto se panel nezobrazí. */
  telemetrySettings?: TelemetryUserSettingRow[];
}

interface DaemonInstallConfig {
  // Base URL k GitHub release assetům, např.
  // "https://github.com/jakubcurik/claude-hub/releases/latest/download"
  releaseDownloadBase: string;
}

interface PublishFields {
  defaultName: string;
  defaultSummary: string;
}

interface ModalState {
  title: string;
  intro: string;
  confirmLabel: string;
  operations: InstallOperation[];
  warnings: string[];
  requiredEnv?: string[];
  publishFields?: PublishFields;
  onConfirm: (overrides?: { name?: string; summary?: string }) => Promise<void>;
}

const navItems: SidebarNavItem[] = [
  { id: "catalog", label: "Katalog" },
  { id: "local", label: "Tento počítač" },
  { id: "collections", label: "Sady" },
  { id: "team", label: "Tým" },
  { id: "keys", label: "Klíče" }
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

const operationLabels: Record<InstallOperation["type"], string> = {
  create: "Vytvořit",
  replace: "Nahradit",
  backup: "Zálohovat",
  manifest: "Uložit metadata",
  enable: "Zapnout",
  disable: "Vypnout"
};

function formatState(state?: LocalAssetState, connected = false, _assetType?: CatalogAsset["type"]) {
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

export function CatalogExperience({
  collections: initialCollections,
  daemonInstall,
  initialAssets,
  members: initialMembers,
  membership,
  signingKeys: initialSigningKeys,
  userEmail,
  userId,
  teamName,
  initialView,
  telemetrySettings
}: CatalogExperienceProps) {
  const daemon = useDaemon();
  const [collections, setCollections] = useState(initialCollections);
  const [members, setMembers] = useState(initialMembers);
  const [signingKeys, setSigningKeys] = useState(initialSigningKeys);
  const [diffModal, setDiffModal] = useState<{ asset: CatalogAsset; diff: AssetDiff } | null>(null);
  const [scopePicker, setScopePicker] = useState<{
    asset: CatalogAsset;
    projects: KnownProject[];
  } | null>(null);
  const [versionsModal, setVersionsModal] = useState<{
    asset: CatalogAsset;
    versions: Array<{ version: string; publishedAt: string; publishedBy: string; signature?: string }>;
  } | null>(null);
  const [generatedKey, setGeneratedKey] = useState<{ label: string; privateKeyPem: string; fingerprint: string } | null>(
    null
  );
  const [detailModal, setDetailModal] = useState<{
    name: string;
    type: AssetType;
    subtitle?: string;
    files: AssetFile[];
    loading?: boolean;
  } | null>(null);
  const isAdmin = membership.role === "owner" || membership.role === "admin";
  const isOwner = membership.role === "owner";
  const [activeView, setActiveView] = useState<View>(initialView ?? "catalog");
  const [catalogFilter, setCatalogFilter] = useState<Filter>("all");
  const [localFilter, setLocalFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [states, setStates] = useState<Record<string, LocalAssetState>>({});
  const [localAssets, setLocalAssets] = useState<LocalAsset[]>([]);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const setBusy = setOperationBusy;
  const lastFetchedConnectionVersion = useRef(0);

  // Daemon stav teče z DaemonProvideru. Lokálně si držíme jen content state
  // (states položek + localAssets) — ten závisí na catalog assetech, které
  // provider nezná.
  const {
    client,
    isConnected,
    busy: daemonBusy,
    connectionVersion,
    refresh: refreshDaemon,
    pairAutomatically,
    toast,
    showToast
  } = daemon;
  const busy = daemonBusy || operationBusy;

  // Po každém úspěšném connect/refresh provideru natáhneme catalog data.
  useEffect(() => {
    if (!isConnected || connectionVersion === lastFetchedConnectionVersion.current) {
      return;
    }
    lastFetchedConnectionVersion.current = connectionVersion;
    let cancelled = false;
    (async () => {
      try {
        const [nextStates, nextLocalAssets] = await Promise.all([
          client.state(initialAssets),
          client.localAssets()
        ]);
        if (cancelled) return;
        setStates(Object.fromEntries(nextStates.map((item) => [item.assetId, item])));
        setLocalAssets(nextLocalAssets.map(normalizeLocalAsset));
      } catch (error) {
        if (cancelled) return;
        setStates({});
        setLocalAssets([]);
        showToast(error instanceof Error ? error.message : "Stav katalogu se nepodařilo načíst.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, connectionVersion, initialAssets, isConnected, showToast]);

  // Když se daemon odpojí, vyčistíme catalog content.
  useEffect(() => {
    if (!isConnected) {
      lastFetchedConnectionVersion.current = 0;
      setStates({});
      setLocalAssets([]);
    }
  }, [isConnected]);

  const refresh = useCallback(async () => {
    await refreshDaemon();
  }, [refreshDaemon]);

  const knownProjects = daemon.knownProjects;

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

  // Seskupení identických položek podle (type, slug, contentFingerprint).
  // Stejný skill ležící v několika projektech (s identickým obsahem) se zobrazí
  // jako jedna karta se seznamem zdrojů.
  const groupedLocalAssets = useMemo(() => {
    const groups = new Map<string, LocalAsset[]>();
    for (const asset of visibleLocalAssets) {
      const key = `${asset.type}:${asset.slug}:${asset.contentFingerprint ?? asset.localAssetId}`;
      const list = groups.get(key) ?? [];
      list.push(asset);
      groups.set(key, list);
    }
    return Array.from(groups.values()).sort((a, b) => a[0].name.localeCompare(b[0].name, "cs"));
  }, [visibleLocalAssets]);

  const installedCount = Object.values(states).filter((state) => state.installed).length;
  const updateCount = Object.values(states).filter((state) => state.updateAvailable).length;

  async function requestInstall(asset: CatalogAsset) {
    // Daemon vrací knownProjects ze sekce projects v ~/.claude.json.
    // Pokud daemon zatím nestihl hello, použij projekty z localAssets jako fallback.
    let projects: KnownProject[] = knownProjects;
    if (projects.length === 0) {
      const seen = new Map<string, KnownProject>();
      for (const item of localAssets) {
        if (item.scope === "project" && item.projectPath && item.projectName) {
          if (!seen.has(item.projectPath)) {
            seen.set(item.projectPath, {
              path: item.projectPath,
              name: item.projectName,
              accessible: true,
              claudeDirExists: true
            });
          }
        }
      }
      projects = Array.from(seen.values());
    }
    setScopePicker({ asset, projects });
  }

  async function confirmInstallScope(asset: CatalogAsset, options: InstallOptions) {
    setScopePicker(null);
    try {
      const preview = await client.installPreview(asset, options);
      const scopeLabel =
        options.scope === "project"
          ? localAssets.find((a) => a.projectPath === options.projectPath)?.projectName || "projekt"
          : "Osobní";
      setModal({
        title: states[asset.id]?.installed
          ? `Aktualizovat ${asset.name} (${scopeLabel})`
          : `Nainstalovat ${asset.name} (${scopeLabel})`,
        intro: "Než se cokoli zapíše do Claude Code, zkontrolujte plánované změny v souborech.",
        confirmLabel: states[asset.id]?.installed ? "Použít aktualizaci" : "Nainstalovat",
        operations: preview.operations,
        warnings: preview.warnings,
        requiredEnv: preview.requiredEnv,
        onConfirm: async () => {
          await client.install(asset, options);
          setModal(null);
          await refresh();
          showToast(`Nainstalováno: ${asset.name} (${scopeLabel}).`);
          void logCatalogEvent({
            event: states[asset.id]?.installed ? "update" : "install",
            assetId: asset.id,
            assetVersion: asset.version
          });
        }
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Náhled instalace selhal.");
    }
  }

  async function setEnabled(asset: CatalogAsset, enabled: boolean) {
    await client.setEnabled(asset, enabled);
    await refresh();
    showToast(`${enabled ? "Zapnuto" : "Vypnuto"}: ${asset.name}.`);
    void logCatalogEvent({
      event: enabled ? "enable" : "disable",
      assetId: asset.id,
      assetVersion: asset.version
    });
  }

  async function requestDiff(asset: CatalogAsset) {
    try {
      const diff = await client.diff(asset);
      setDiffModal({ asset, diff });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Diff se nepodařilo načíst.");
    }
  }

  async function requestRollback(asset: CatalogAsset, version: string) {
    if (!window.confirm(`Vrátit ${asset.name} na verzi ${version}?`)) {
      return;
    }
    try {
      await rollbackAssetVersion(asset.type, asset.slug, version);
      showToast(`Katalog vrácen na verzi ${version}.`);
      window.location.reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Rollback selhal.");
    }
  }

  function openAssetDetail(asset: CatalogAsset) {
    setDetailModal({
      name: asset.name,
      type: asset.type,
      subtitle: `${typeLabels[asset.type]} · v${asset.version} · ${asset.owner.name}`,
      files: asset.files ?? []
    });
  }

  async function openLocalAssetDetail(asset: LocalAsset) {
    const subtitle = asset.projectPath
      ? `${typeLabels[asset.type]} · ${asset.projectName} · ${asset.path}`
      : `${typeLabels[asset.type]} · Osobní · ${asset.path}`;
    setDetailModal({ name: asset.name, type: asset.type, subtitle, files: [], loading: true });
    try {
      const exported = await client.exportLocalAsset(asset.localAssetId);
      setDetailModal({ name: asset.name, type: asset.type, subtitle, files: exported.files });
    } catch (error) {
      setDetailModal(null);
      showToast(error instanceof Error ? error.message : "Obsah se nepodařilo načíst.");
    }
  }

  async function openVersionsModal(asset: CatalogAsset) {
    try {
      const { listAssetVersions } = await import("@/app/actions");
      const versions = await listAssetVersions(asset.type, asset.slug);
      setVersionsModal({ asset, versions });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Verze se nepodařilo načíst.");
    }
  }

  async function refreshTeamData() {
    const nextMembers = await listTeamMembers();
    setMembers(nextMembers);
  }

  useEffect(() => {
    if (activeView === "team" && isAdmin) {
      void refreshTeamData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView]);

  async function requestUninstall(asset: CatalogAsset) {
    setModal({
      title: `Odinstalovat ${asset.name}`,
      intro: "Soubory se před smazáním zálohují do .claude-hub/backups/. Akci lze ručně vrátit z této zálohy.",
      confirmLabel: "Odinstalovat",
      operations: [
        {
          type: "backup",
          path: asset.name,
          description: "Zálohovat aktuální lokální položku.",
          risk: "low"
        },
        {
          type: "disable",
          path: asset.name,
          description: "Smazat zapnuté i vypnuté soubory a manifest.",
          risk: asset.risk
        }
      ],
      warnings: [],
      requiredEnv: [],
      onConfirm: async () => {
        await client.uninstall(asset);
        setModal(null);
        await refresh();
        showToast(`Odinstalováno: ${asset.name}.`);
        void logCatalogEvent({
          event: "uninstall",
          assetId: asset.id,
          assetVersion: asset.version
        });
      }
    });
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
        publishFields: {
          defaultName: exported.name,
          defaultSummary: exported.summary
        },
        onConfirm: async (overrides) => {
          const published = await publishLocalAssetToCatalog(exported, overrides);
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
      <AppSidebar
        userEmail={userEmail}
        teamName={teamName}
        navItems={navItems}
        mode={{ type: "internal", activeView, onChangeView: setActiveView }}
      />

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

            <div className={`catalog-grid${busy ? " busy" : ""}`} aria-busy={busy}>
              {busy && visibleAssets.length === 0
                ? Array.from({ length: 4 }).map((_, index) => <AssetCardSkeleton key={index} />)
                : null}
              {visibleAssets.length > 0 ? (
                visibleAssets.map((asset) => (
                  <AssetCard
                    asset={asset}
                    connected={isConnected}
                    key={asset.id}
                    onDiff={() => requestDiff(asset)}
                    onDisable={() => setEnabled(asset, false)}
                    onEnable={() => setEnabled(asset, true)}
                    onInstall={() => requestInstall(asset)}
                    onSelect={() => openAssetDetail(asset)}
                    onShowVersions={() => openVersionsModal(asset)}
                    onUninstall={() => requestUninstall(asset)}
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
              items={groupedLocalAssets.map((group) => {
                const primary = group[0];
                return (
                  <article
                    aria-label={`Zobrazit obsah: ${primary.name}`}
                    className="list-row selectable"
                    key={primary.localAssetId}
                    onClick={() => openLocalAssetDetail(primary)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openLocalAssetDetail(primary);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div>
                      <div className="row-title">
                        <TypePill type={primary.type} />
                        {group.map((item) => (
                          <span
                            className={item.scope === "project" ? "scope-pill project" : "scope-pill user"}
                            key={item.localAssetId}
                            title={item.projectPath || item.path}
                          >
                            {item.scope === "project" ? item.projectName : "Osobní"}
                          </span>
                        ))}
                        <strong>{primary.name}</strong>
                      </div>
                      <p>{primary.projectPath ? `${primary.projectPath} -> ${primary.path}` : primary.path}</p>
                      {primary.warnings.length > 0 ? <WarningLine warnings={primary.warnings} /> : null}
                    </div>
                    <button
                      className="secondary"
                      disabled={!isConnected || busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        requestCatalogUpload(primary);
                      }}
                      type="button"
                    >
                      <FolderUp size={16} />
                      Nahrát do katalogu
                    </button>
                  </article>
                );
              })}
            />
          </section>
        ) : null}

        {activeView === "collections" ? (
          <CollectionsPanel
            assets={initialAssets}
            collections={collections}
            isAdmin={isAdmin}
            onDelete={async (slug) => {
              try {
                await deleteCollection(slug);
                setCollections((current) => current.filter((c) => c.slug !== slug));
                showToast("Sada smazána.");
              } catch (error) {
                showToast(error instanceof Error ? error.message : "Mazání selhalo.");
              }
            }}
            onSave={async (input) => {
              try {
                const saved = await saveCollection(input);
                setCollections((current) => {
                  const others = current.filter((c) => c.slug !== saved.slug);
                  return [saved, ...others];
                });
                showToast(`Sada „${saved.name}" uložena.`);
              } catch (error) {
                showToast(error instanceof Error ? error.message : "Uložení selhalo.");
              }
            }}
          />
        ) : null}

        {activeView === "team" ? (
          <>
            <TeamPanel
              isAdmin={isAdmin}
              members={members}
              onRefresh={refreshTeamData}
              onRemoveMember={async (memberUserId) => {
                try {
                  await removeTeamMember(memberUserId);
                  await refreshTeamData();
                  showToast("Člen byl odebrán.");
                } catch (error) {
                  showToast(error instanceof Error ? error.message : "Odebrání selhalo.");
                }
              }}
              onSetRole={async (memberUserId, role) => {
                try {
                  await updateMemberRole(memberUserId, role);
                  await refreshTeamData();
                } catch (error) {
                  showToast(error instanceof Error ? error.message : "Změna role selhala.");
                }
              }}
              currentUserId={userId}
            />
            {isOwner && telemetrySettings ? (
              <section className="analytics-card analytics-card-wide" style={{ marginTop: 18 }}>
                <header>
                  <h3>Nastavení sběru telemetrie</h3>
                  <p>
                    Telemetrie se zapíná automaticky při spárování. Jako vlastník můžete pro
                    konkrétní uživatele centrálně zakázat odesílání — daemon do několika minut sám
                    přestane exportovat.
                  </p>
                </header>
                <OwnerSettings initialUsers={telemetrySettings} />
              </section>
            ) : null}
          </>
        ) : null}

        {activeView === "keys" ? (
          <SigningKeysPanel
            keys={signingKeys}
            onGenerate={async () => {
              const label = window.prompt("Pojmenujte klíč (např. Notebook)");
              if (!label) return;
              try {
                const result = await generateAndRegisterSigningKey(label);
                setSigningKeys((current) => [result.key, ...current]);
                setGeneratedKey({
                  label,
                  privateKeyPem: result.privateKeyPem,
                  fingerprint: result.fingerprint
                });
              } catch (error) {
                showToast(error instanceof Error ? error.message : "Klíč se nepodařilo vygenerovat.");
              }
            }}
            onRevoke={async (keyId) => {
              if (!window.confirm("Opravdu revoknout tento klíč? Předchozí podpisy zůstávají platné.")) return;
              try {
                await revokeSigningKey(keyId);
                setSigningKeys((current) => current.filter((key) => key.id !== keyId));
                showToast("Klíč byl revoknutý.");
              } catch (error) {
                showToast(error instanceof Error ? error.message : "Revokace selhala.");
              }
            }}
          />
        ) : null}
      </main>

      {scopePicker ? (
        <InstallScopeModal
          asset={scopePicker.asset}
          projects={scopePicker.projects}
          onCancel={() => setScopePicker(null)}
          onConfirm={(options) => confirmInstallScope(scopePicker.asset, options)}
        />
      ) : null}

      {modal ? (
        <InstallModal
          busy={busy}
          modal={modal}
          onClose={() => setModal(null)}
          onConfirm={async (overrides) => {
            setBusy(true);
            try {
              await modal.onConfirm(overrides);
            } catch (error) {
              showToast(error instanceof Error ? error.message : "Akce se nepodařila dokončit.");
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {diffModal ? (
        <DiffModal
          asset={diffModal.asset}
          diff={diffModal.diff}
          onClose={() => setDiffModal(null)}
        />
      ) : null}

      {versionsModal ? (
        <VersionsModal
          asset={versionsModal.asset}
          isAdmin={isAdmin}
          versions={versionsModal.versions}
          onClose={() => setVersionsModal(null)}
          onRollback={(version) => requestRollback(versionsModal.asset, version)}
        />
      ) : null}

      {generatedKey ? (
        <KeyRevealModal
          generatedKey={generatedKey}
          onClose={() => setGeneratedKey(null)}
        />
      ) : null}

      {detailModal ? (
        <AssetDetailModal
          files={detailModal.files}
          loading={detailModal.loading}
          name={detailModal.name}
          onClose={() => setDetailModal(null)}
          subtitle={detailModal.subtitle}
          type={detailModal.type}
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
          <DaemonDownload option={selectedOption} />
          <InstallCommand
            command={selectedOption.runCommand}
            copied={copiedCommand === selectedOption.runCommand}
            label="Po stažení spusťte v terminálu"
            onCopy={copyCommand}
          />
          {selectedOption.altDownload ? (
            <details className="fallback-install">
              <summary>Jiná architektura</summary>
              <a
                className="install-download-link"
                href={selectedOption.altDownload.url}
                rel="noreferrer"
                target="_blank"
              >
                <Download size={15} />
                {selectedOption.altDownload.label} — {selectedOption.altDownload.filename}
              </a>
            </details>
          ) : null}
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
  label: string;
  platform: InstallPlatform;
  downloadUrl: string;
  downloadFilename: string;
  // Krátký návod jak po stažení daemon spustit (jeden řádek terminálu).
  runCommand: string;
  // Volitelná druhá architektura (typicky ARM). Když je null, ukáže se jen
  // primární download. ARM Mac (M1+) je realistický use case, ARM Win nikoliv.
  altDownload?: { url: string; filename: string; label: string };
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

function DaemonDownload({ option }: { option: InstallOption }) {
  return (
    <a
      className="install-download primary"
      href={option.downloadUrl}
      rel="noreferrer"
      target="_blank"
    >
      <Download size={16} />
      <span>
        <strong>Stáhnout pro {option.label}</strong>
        <small>{option.downloadFilename}</small>
      </span>
    </a>
  );
}

function daemonInstallOptions(config: DaemonInstallConfig): InstallOption[] {
  const base = config.releaseDownloadBase.replace(/\/$/, "");
  return [
    {
      label: "Windows",
      platform: "windows",
      downloadUrl: `${base}/claude-hub-daemon_windows_amd64.zip`,
      downloadFilename: "claude-hub-daemon_windows_amd64.zip",
      runCommand: ".\\claude-hub-daemon.exe"
    },
    {
      label: "macOS",
      platform: "macos",
      downloadUrl: `${base}/claude-hub-daemon_darwin_arm64.tar.gz`,
      downloadFilename: "claude-hub-daemon_darwin_arm64.tar.gz",
      runCommand: "tar -xzf claude-hub-daemon_darwin_arm64.tar.gz && ./claude-hub-daemon",
      altDownload: {
        url: `${base}/claude-hub-daemon_darwin_amd64.tar.gz`,
        filename: "claude-hub-daemon_darwin_amd64.tar.gz",
        label: "Intel Mac (amd64)"
      }
    },
    {
      label: "Linux",
      platform: "linux",
      downloadUrl: `${base}/claude-hub-daemon_linux_amd64.tar.gz`,
      downloadFilename: "claude-hub-daemon_linux_amd64.tar.gz",
      runCommand: "tar -xzf claude-hub-daemon_linux_amd64.tar.gz && ./claude-hub-daemon",
      altDownload: {
        url: `${base}/claude-hub-daemon_linux_arm64.tar.gz`,
        filename: "claude-hub-daemon_linux_arm64.tar.gz",
        label: "ARM64 (např. Raspberry Pi)"
      }
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
  onDiff,
  onDisable,
  onEnable,
  onInstall,
  onSelect,
  onShowVersions,
  onUninstall,
  state
}: {
  asset: CatalogAsset;
  connected: boolean;
  onDiff: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onInstall: () => void;
  onSelect: () => void;
  onShowVersions: () => void;
  onUninstall: () => void;
  state?: LocalAssetState;
}) {
  const status = formatState(state, connected, asset.type);
  // Daemon podporuje plný lifecycle pro všechny typy (skill, command, mcp, hook, plugin, config).
  const supported = true;

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  }

  return (
    <article
      aria-label={`Zobrazit obsah: ${asset.name}`}
      className="asset-card selectable"
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
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
      <div className="card-actions" onClick={(event) => event.stopPropagation()}>
        {renderAssetAction({ connected, onDisable, onEnable, onInstall, state, supported })}
        {supported && connected && state?.localChanges ? (
          <button className="secondary" onClick={onDiff} type="button" title="Zobrazit změny">
            Diff
          </button>
        ) : null}
        <button className="secondary" onClick={onShowVersions} type="button" title="Historie verzí">
          Verze
        </button>
        {supported && connected && state?.installed ? (
          <button
            aria-label="Odinstalovat"
            className="icon-button danger"
            onClick={onUninstall}
            title="Odinstalovat"
            type="button"
          >
            <X size={15} />
          </button>
        ) : null}
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

function AssetCardSkeleton() {
  return (
    <article className="asset-card skeleton" aria-hidden="true">
      <div className="skeleton-line short" />
      <div className="skeleton-line" />
      <div className="skeleton-line" />
      <div className="skeleton-line short" />
    </article>
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

function formatRelativeTime(iso: string) {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) {
    return "neznámo";
  }
  const diffSeconds = Math.round((target - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat("cs", { numeric: "auto" });
  if (absSeconds < 60) {
    return formatter.format(diffSeconds, "second");
  }
  if (absSeconds < 3600) {
    return formatter.format(Math.round(diffSeconds / 60), "minute");
  }
  if (absSeconds < 86_400) {
    return formatter.format(Math.round(diffSeconds / 3600), "hour");
  }
  return formatter.format(Math.round(diffSeconds / 86_400), "day");
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

function InstallScopeModal({
  asset,
  onCancel,
  onConfirm,
  projects
}: {
  asset: CatalogAsset;
  onCancel: () => void;
  onConfirm: (options: InstallOptions) => void;
  projects: KnownProject[];
}) {
  // Setřídit: dostupné s .claude/ první, pak ostatní dostupné, pak nedostupné.
  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const rank = (p: KnownProject) =>
        p.accessible && p.claudeDirExists ? 0 : p.accessible ? 1 : 2;
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, "cs");
    });
  }, [projects]);

  const firstAccessible = sortedProjects.find((p) => p.accessible);
  const [scope, setScope] = useState<"user" | "project">("user");
  const [projectPath, setProjectPath] = useState<string>(firstAccessible?.path ?? "");

  const selectedProject = sortedProjects.find((p) => p.path === projectPath);
  const canSubmit = scope === "user" || (scope === "project" && selectedProject?.accessible);

  function submit() {
    if (!canSubmit) return;
    onConfirm({ scope, projectPath: scope === "project" ? projectPath : undefined });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="scope-modal-title" aria-modal="true" className="modal" role="dialog">
        <div className="modal-head">
          <div>
            <h2 id="scope-modal-title">Kam nainstalovat {asset.name}?</h2>
            <p>
              Vyberte, jestli se má položka uložit do vašeho uživatelského profilu, nebo jen do konkrétního
              projektu. V projektu zůstane lokálně a sdílí se s ostatními přes Git.
            </p>
          </div>
          <button aria-label="Zavřít dialog" className="icon-button" onClick={onCancel} type="button">
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          <div className="scope-options">
            <label className={`scope-option${scope === "user" ? " selected" : ""}`}>
              <input
                checked={scope === "user"}
                name="install-scope"
                onChange={() => setScope("user")}
                type="radio"
                value="user"
              />
              <div>
                <strong>Osobní (~/.claude/)</strong>
                <span>Dostupné ve všech vašich projektech.</span>
              </div>
            </label>
            <label
              className={`scope-option${scope === "project" ? " selected" : ""}${projects.length === 0 ? " disabled" : ""}`}
            >
              <input
                checked={scope === "project"}
                disabled={projects.length === 0}
                name="install-scope"
                onChange={() => setScope("project")}
                type="radio"
                value="project"
              />
              <div>
                <strong>Projekt</strong>
                <span>
                  {projects.length === 0
                    ? "Žádné projekty zatím detekované. Spusťte v projektu Claude Code, pak se objeví zde."
                    : "Uloží se do <project>/.claude/, projekt si položku ponese s sebou."}
                </span>
                {scope === "project" && sortedProjects.length > 0 ? (
                  <>
                    <select
                      className="scope-project-select"
                      onChange={(event) => setProjectPath(event.target.value)}
                      value={projectPath}
                    >
                      {sortedProjects.map((project) => {
                        const note =
                          !project.accessible
                            ? " (mimo Docker mount)"
                            : !project.claudeDirExists
                            ? " (chybí .claude/)"
                            : "";
                        return (
                          <option
                            disabled={!project.accessible}
                            key={project.path}
                            value={project.path}
                          >
                            {project.name} — {project.path}
                            {note}
                          </option>
                        );
                      })}
                    </select>
                    {selectedProject && !selectedProject.accessible ? (
                      <p className="scope-warning">
                        Tento projekt není pro daemona v aktuálním Docker setupu dostupný. Buď ho
                        přidejte do compose mountů, nebo spusťte daemon nativně.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            </label>
          </div>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel} type="button">
            Zrušit
          </button>
          <button className="primary" disabled={!canSubmit} onClick={submit} type="button">
            Pokračovat
          </button>
        </div>
      </section>
    </div>
  );
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
  onConfirm: (overrides?: { name?: string; summary?: string }) => Promise<void>;
}) {
  const [publishName, setPublishName] = useState(modal.publishFields?.defaultName ?? "");
  const [publishSummary, setPublishSummary] = useState(modal.publishFields?.defaultSummary ?? "");

  function handleConfirm() {
    if (modal.publishFields) {
      void onConfirm({ name: publishName, summary: publishSummary });
    } else {
      void onConfirm();
    }
  }

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
          {modal.publishFields ? (
            <div className="publish-fields">
              <label>
                <span>Název v katalogu</span>
                <input
                  onChange={(event) => setPublishName(event.target.value)}
                  placeholder={modal.publishFields.defaultName}
                  type="text"
                  value={publishName}
                />
                <small>Volitelné — pokud necháte prázdné, použije se „{modal.publishFields.defaultName}".</small>
              </label>
              <label>
                <span>Krátký popis</span>
                <textarea
                  onChange={(event) => setPublishSummary(event.target.value)}
                  placeholder="Jednou větou, k čemu položka slouží."
                  rows={2}
                  value={publishSummary}
                />
              </label>
            </div>
          ) : null}

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
          <button className="primary" disabled={busy} onClick={handleConfirm} type="button">
            {modal.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

// ────────────────── Sub-komponenty: panely a modaly ──────────────────

function CollectionsPanel({
  assets,
  collections,
  isAdmin,
  onDelete,
  onSave
}: {
  assets: CatalogAsset[];
  collections: Collection[];
  isAdmin: boolean;
  onDelete: (slug: string) => void;
  onSave: (input: { slug: string; name: string; description: string; assetIds: string[] }) => void;
}) {
  const [editing, setEditing] = useState<Collection | null>(null);
  const [draftAssetIds, setDraftAssetIds] = useState<Set<string>>(new Set());
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftSlug, setDraftSlug] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);

  function startEdit(collection: Collection | null) {
    setEditing(collection);
    setDraftAssetIds(new Set(collection?.assetIds ?? []));
    setDraftName(collection?.name ?? "");
    setDraftDescription(collection?.description ?? "");
    setDraftSlug(collection?.slug ?? "");
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditing(null);
    setDraftAssetIds(new Set());
    setDraftName("");
    setDraftSlug("");
    setDraftDescription("");
    setEditorOpen(false);
  }

  function toggleAsset(assetId: string) {
    setDraftAssetIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) {
        next.delete(assetId);
      } else {
        next.add(assetId);
      }
      return next;
    });
  }

  return (
    <section className="workspace collections-workspace">
      <div className="info-panel">
        <strong>Sady pro rychlou orientaci</strong>
        <span>
          Seskupte související skilly, příkazy a hooky do tematických balíčků (např. onboarding nebo frontend
          workflow).
        </span>
      </div>
      <div className="collections-grid">
        {collections.map((collection) => (
          <article className="collection-card" key={collection.id}>
            <header>
              <h2>{collection.name}</h2>
              <span className="muted">{collection.slug}</span>
            </header>
            <p>{collection.description || "Bez popisu."}</p>
            <ul>
              {collection.assetIds.map((assetId) => {
                const asset = assets.find((item) => item.id === assetId);
                return (
                  <li key={assetId}>
                    <TypePill type={(asset?.type ?? "skill") as AssetType} />
                    {asset?.name ?? assetId}
                  </li>
                );
              })}
            </ul>
            {isAdmin ? (
              <div className="collection-actions">
                <button className="secondary" onClick={() => startEdit(collection)} type="button">
                  Upravit
                </button>
                <button className="secondary dark" onClick={() => onDelete(collection.slug)} type="button">
                  Smazat
                </button>
              </div>
            ) : null}
          </article>
        ))}
        {isAdmin ? (
          <button className="collection-create" onClick={() => startEdit(null)} type="button">
            + Nová sada
          </button>
        ) : null}
      </div>

      {editorOpen && isAdmin ? (
        <section className="collection-editor" aria-label="Editor sady">
          <h2>{editing ? `Upravit ${editing.name}` : "Nová sada"}</h2>
          <label>
            <span>Název</span>
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </label>
          <label>
            <span>Slug</span>
            <input
              value={draftSlug}
              disabled={Boolean(editing)}
              onChange={(event) => setDraftSlug(event.target.value)}
            />
          </label>
          <label>
            <span>Popis</span>
            <textarea
              rows={3}
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Vybrané položky</legend>
            <div className="collection-asset-grid">
              {assets.map((asset) => {
                const selected = draftAssetIds.has(asset.id);
                return (
                  <label className={selected ? "selected" : ""} key={asset.id}>
                    <input checked={selected} onChange={() => toggleAsset(asset.id)} type="checkbox" />
                    <span>
                      <TypePill type={asset.type} /> {asset.name}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="collection-editor-actions">
            <button
              className="primary"
              type="button"
              onClick={() => {
                if (!draftName || !draftSlug) {
                  return;
                }
                onSave({
                  slug: draftSlug,
                  name: draftName,
                  description: draftDescription,
                  assetIds: Array.from(draftAssetIds)
                });
                closeEditor();
              }}
            >
              Uložit
            </button>
            <button className="secondary" type="button" onClick={closeEditor}>
              Zrušit
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function TeamPanel({
  currentUserId,
  isAdmin,
  members,
  onRefresh,
  onRemoveMember,
  onSetRole
}: {
  currentUserId: string;
  isAdmin: boolean;
  members: TeamMembership[];
  onRefresh: () => void;
  onRemoveMember: (userId: string) => void;
  onSetRole: (userId: string, role: "admin" | "member" | "owner") => void;
}) {
  return (
    <section className="workspace team-workspace">
      <div className="info-panel">
        <strong>Tým a oprávnění</strong>
        <span>
          Členem se automaticky stane každý, kdo se poprvé přihlásí. Pošlete kolegům odkaz na přihlašovací
          stránku — po jejich registraci se zde objeví a vy jim můžete změnit roli nebo je odebrat.
        </span>
      </div>

      <section className="team-members">
        <header>
          <h2>Členové ({members.length})</h2>
          <button className="secondary" onClick={onRefresh} type="button">
            Aktualizovat
          </button>
        </header>
        <table>
          <thead>
            <tr>
              <th>E-mail</th>
              <th>Role</th>
              <th>Členem od</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td>{member.email}</td>
                <td>
                  {isAdmin && member.userId !== currentUserId ? (
                    <select
                      value={member.role}
                      onChange={(event) =>
                        onSetRole(member.userId, event.target.value as "admin" | "member" | "owner")
                      }
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                  ) : (
                    member.role
                  )}
                </td>
                <td>{formatRelativeTime(member.joinedAt)}</td>
                <td>
                  {isAdmin && member.userId !== currentUserId ? (
                    <button
                      className="secondary dark"
                      onClick={() => onRemoveMember(member.userId)}
                      type="button"
                    >
                      Odebrat
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}

function SigningKeysPanel({
  keys,
  onGenerate,
  onRevoke
}: {
  keys: SigningKey[];
  onGenerate: () => void;
  onRevoke: (keyId: string) => void;
}) {
  return (
    <section className="workspace signing-workspace">
      <div className="info-panel">
        <strong>Podepisování balíčků</strong>
        <span>
          Vygenerujte Ed25519 klíč. Privátní část si stáhněte a uložte; veřejnou Hub uchová a použije při ověření
          podpisů u publikovaných položek.
        </span>
      </div>
      <button className="primary" onClick={onGenerate} type="button">
        Vygenerovat nový klíč
      </button>
      <ul className="signing-list">
        {keys.length === 0 ? <li className="muted">Žádné klíče.</li> : null}
        {keys.map((key) => (
          <li key={key.id}>
            <div>
              <strong>{key.label}</strong>
              <code>{key.publicKey.slice(0, 32)}…</code>
              <span className="muted">
                {key.revokedAt
                  ? "revoknutý"
                  : `vytvořen ${formatRelativeTime(key.createdAt)}${
                      key.lastUsedAt ? ", použit " + formatRelativeTime(key.lastUsedAt) : ""
                    }`}
              </span>
            </div>
            {!key.revokedAt ? (
              <button className="secondary dark" onClick={() => onRevoke(key.id)} type="button">
                Revoknout
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function KeyRevealModal({
  generatedKey,
  onClose
}: {
  generatedKey: { label: string; privateKeyPem: string; fingerprint: string };
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="key-reveal-title" aria-modal="true" className="modal" role="dialog">
        <div className="modal-head">
          <div>
            <h2 id="key-reveal-title">Privátní klíč „{generatedKey.label}"</h2>
            <p>Tento klíč už nikdy znovu nezobrazíme. Stáhněte si ho a uložte bezpečně.</p>
          </div>
          <button aria-label="Zavřít" className="icon-button" onClick={onClose} type="button">
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          <p>
            Otisk: <code>{generatedKey.fingerprint}</code>
          </p>
          <textarea className="key-textarea" readOnly rows={10} value={generatedKey.privateKeyPem} />
        </div>
        <div className="modal-actions">
          <button
            className="primary"
            onClick={async () => {
              await navigator.clipboard.writeText(generatedKey.privateKeyPem);
            }}
            type="button"
          >
            Zkopírovat
          </button>
          <button
            className="secondary"
            onClick={() => {
              const blob = new Blob([generatedKey.privateKeyPem], { type: "application/x-pem-file" });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = `${generatedKey.label.replace(/\s+/g, "-")}.pem`;
              link.click();
              URL.revokeObjectURL(url);
            }}
            type="button"
          >
            Stáhnout PEM
          </button>
          <button className="secondary dark" onClick={onClose} type="button">
            Uložil(a) jsem si klíč
          </button>
        </div>
      </section>
    </div>
  );
}

function DiffModal({
  asset,
  diff,
  onClose
}: {
  asset: CatalogAsset;
  diff: AssetDiff;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="diff-title" aria-modal="true" className="modal wide" role="dialog">
        <div className="modal-head">
          <div>
            <h2 id="diff-title">Diff: {asset.name}</h2>
            <p>Porovnání lokální verze s aktuálním obsahem v katalogu.</p>
          </div>
          <button aria-label="Zavřít" className="icon-button" onClick={onClose} type="button">
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          {diff.files.length === 0 ? (
            <p className="muted">Žádné soubory ke srovnání.</p>
          ) : (
            diff.files.map((file) => (
              <section className="diff-file" key={file.path}>
                <header>
                  <strong>{file.path}</strong>
                  <span className={`diff-status ${file.status}`}>{file.status}</span>
                </header>
                <pre>
                  {file.lines.map((line, index) => (
                    <span className={`diff-line ${line.type}`} key={index}>
                      {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "} {line.text}
                    </span>
                  ))}
                </pre>
              </section>
            ))
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose} type="button">
            Zavřít
          </button>
        </div>
      </section>
    </div>
  );
}

function AssetDetailModal({
  files,
  loading,
  name,
  onClose,
  subtitle,
  type
}: {
  files: AssetFile[];
  loading?: boolean;
  name: string;
  onClose: () => void;
  subtitle?: string;
  type: AssetType;
}) {
  const [activePath, setActivePath] = useState<string>(files[0]?.path ?? "");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (files.length > 0 && !files.find((file) => file.path === activePath)) {
      setActivePath(files[0].path);
    }
  }, [files, activePath]);

  const activeFile = files.find((file) => file.path === activePath) ?? files[0];

  async function copyContent() {
    if (!activeFile) return;
    await navigator.clipboard.writeText(activeFile.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        aria-labelledby="detail-modal-title"
        aria-modal="true"
        className="modal wide asset-detail-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="modal-head">
          <div>
            <h2 id="detail-modal-title">
              <TypePill type={type} /> {name}
            </h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button aria-label="Zavřít" className="icon-button" onClick={onClose} type="button">
            <X size={17} />
          </button>
        </div>
        <div className="modal-body asset-detail-body">
          {loading ? (
            <p className="muted">Načítám obsah…</p>
          ) : files.length === 0 ? (
            <p className="muted">Tato položka neobsahuje žádné soubory.</p>
          ) : (
            <div className="asset-detail-layout">
              <aside className="asset-detail-files" aria-label="Seznam souborů">
                {files.map((file) => (
                  <button
                    className={file.path === activeFile?.path ? "active" : ""}
                    key={file.path}
                    onClick={() => setActivePath(file.path)}
                    title={file.path}
                    type="button"
                  >
                    <FileText size={14} />
                    <span>{file.path}</span>
                  </button>
                ))}
              </aside>
              <div className="asset-detail-content">
                {activeFile ? (
                  <>
                    <header>
                      <code>{activeFile.path}</code>
                      <button className="secondary" onClick={copyContent} type="button">
                        <Copy size={14} />
                        {copied ? "Zkopírováno" : "Kopírovat"}
                      </button>
                    </header>
                    <pre>{activeFile.content || "(prázdný soubor)"}</pre>
                  </>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function VersionsModal({
  asset,
  isAdmin,
  versions,
  onClose,
  onRollback
}: {
  asset: CatalogAsset;
  isAdmin: boolean;
  versions: Array<{ version: string; publishedAt: string; publishedBy: string; signature?: string }>;
  onClose: () => void;
  onRollback: (version: string) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="versions-title" aria-modal="true" className="modal" role="dialog">
        <div className="modal-head">
          <div>
            <h2 id="versions-title">Historie verzí: {asset.name}</h2>
            <p>Každý publish je zachycený. Admin může vrátit katalog na starší verzi.</p>
          </div>
          <button aria-label="Zavřít" className="icon-button" onClick={onClose} type="button">
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          {versions.length === 0 ? (
            <p className="muted">Žádné verze.</p>
          ) : (
            <ul className="version-list">
              {versions.map((version) => (
                <li key={version.version}>
                  <div>
                    <strong>{version.version}</strong>
                    <span className="muted">
                      publikováno {formatRelativeTime(version.publishedAt)}
                      {version.signature ? " · podepsáno" : ""}
                    </span>
                  </div>
                  {isAdmin ? (
                    <button className="secondary" onClick={() => onRollback(version.version)} type="button">
                      Vrátit
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose} type="button">
            Zavřít
          </button>
        </div>
      </section>
    </div>
  );
}
