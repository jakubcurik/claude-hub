"use client";

import { ChevronRight, MonitorCheck, PlugZap, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useDaemon } from "@/lib/daemon-context";
import { logoutAction } from "@/app/actions";

export type SidebarView = "catalog" | "local" | "collections" | "team" | "keys";

export interface SidebarNavItem {
  id: SidebarView;
  label: string;
}

export type SidebarMode =
  | { type: "internal"; activeView: SidebarView; onChangeView: (view: SidebarView) => void }
  | { type: "external" };

interface AppSidebarProps {
  userEmail: string;
  teamName: string;
  navItems: SidebarNavItem[];
  mode: SidebarMode;
  /** Když je true, "Analytika" link je zvýrazněný. Default false. */
  analyticsActive?: boolean;
}

const ANALYTICS_HREF = "/analytics";

/**
 * AppSidebar je jediný zdroj sidebar UI v Hubu. Daemon stav i akce konzumuje
 * z DaemonContext — sidebar je proto identický napříč stránkami.
 *
 * Nav režim:
 * - "internal" — používá se uvnitř CatalogExperience, mění in-memory view
 * - "external" — používá se na /analytics, naviguje na "/?view=X"
 */
export function AppSidebar({
  userEmail,
  teamName,
  navItems,
  mode,
  analyticsActive = false
}: AppSidebarProps) {
  const daemon = useDaemon();
  const normalizedToken = daemon.savedToken.trim();

  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-mark">CH</div>
        <div>
          <strong>Claude Hub</strong>
          <span>{teamName}</span>
        </div>
      </div>
      <form action={logoutAction} className="account-block">
        <span>{userEmail}</span>
        <button className="secondary dark" type="submit">
          Odhlásit
        </button>
      </form>

      <nav className="nav-list" aria-label="Hlavní navigace">
        {navItems.map((item) =>
          mode.type === "internal" ? (
            <button
              className={mode.activeView === item.id && !analyticsActive ? "active" : ""}
              key={item.id}
              onClick={() => mode.onChangeView(item.id)}
              type="button"
            >
              <span>{item.label}</span>
              <ChevronRight size={16} />
            </button>
          ) : (
            <a className="nav-list-link" key={item.id} href={`/?view=${item.id}`}>
              <span>{item.label}</span>
              <ChevronRight size={16} />
            </a>
          )
        )}
        <Link
          className={`nav-list-link${analyticsActive ? " is-active" : ""}`}
          href={ANALYTICS_HREF}
        >
          <span>Analytika</span>
          <ChevronRight size={16} />
        </Link>
      </nav>

      <section className="daemon-card" aria-label="Připojení lokální služby">
        <div className="daemon-title">
          <MonitorCheck size={17} />
          <strong>Lokální služba</strong>
        </div>
        <p>{daemon.daemonSummary}</p>
        <div className="daemon-actions">
          <button
            className="primary"
            disabled={daemon.busy}
            onClick={daemon.pairAutomatically}
            type="button"
          >
            <PlugZap size={16} />
            Spárovat
          </button>
          <button
            className="secondary dark"
            disabled={daemon.busy}
            onClick={() => daemon.refresh()}
            type="button"
          >
            <RefreshCw size={16} />
            Obnovit stav
          </button>
          <button
            className="secondary dark"
            disabled={daemon.busy || !normalizedToken}
            onClick={daemon.disconnect}
            type="button"
          >
            Odpojit
          </button>
        </div>
        <details
          className="paired-devices"
          open={daemon.devicesOpen}
          onToggle={(event) => daemon.setDevicesOpen(event.currentTarget.open)}
        >
          <summary>Spárovaná zařízení ({daemon.pairedDevices.length})</summary>
          {daemon.pairedDevices.length === 0 ? (
            <p className="muted">Zatím nejsou evidovaná žádná zařízení.</p>
          ) : (
            <ul className="device-list">
              {daemon.pairedDevices.map((device) => (
                <li key={device.tokenHash}>
                  <div>
                    <strong>{device.label}</strong>
                    <span>{device.claudeHome}</span>
                    <span className="muted">Naposledy viděno {formatRelativeTime(device.lastSeenAt)}</span>
                  </div>
                  <button
                    className="secondary dark"
                    onClick={() => daemon.revokeDevice(device.tokenHash)}
                    type="button"
                  >
                    Zrušit
                  </button>
                </li>
              ))}
            </ul>
          )}
        </details>
        <details
          className="manual-pairing"
          open={daemon.manualPairingOpen}
          onToggle={(event) => daemon.setManualPairingOpen(event.currentTarget.open)}
        >
          <summary>Zadat token ručně</summary>
          <label htmlFor="pairing-token">Párovací token</label>
          <input
            autoComplete="off"
            id="pairing-token"
            onChange={(event) => daemon.setToken(event.target.value)}
            placeholder="Vložte párovací token"
            spellCheck={false}
            type="password"
            value={daemon.token}
          />
          <button
            className="secondary dark"
            disabled={daemon.busy}
            onClick={daemon.saveToken}
            type="button"
          >
            Připojit
          </button>
        </details>
      </section>
    </aside>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return iso;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "před chvílí";
  if (minutes < 60) return `před ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `před ${hours} h`;
  const days = Math.round(hours / 24);
  return `před ${days} d`;
}
