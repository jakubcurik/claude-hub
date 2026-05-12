"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { DaemonHello, KnownProject } from "@claude-hub/schema";
import { DaemonClient } from "@/lib/daemon-client";
import { listPairedDevices, registerPairedDevice, revokePairedDevice } from "@/app/actions";

const tokenStorageKey = "claudeHubDaemonToken";
const daemonOrigin = "http://127.0.0.1:17373";

export interface PairedDeviceSummary {
  tokenHash: string;
  label: string;
  claudeHome: string;
  lastSeenAt: string;
}

interface DaemonContextValue {
  token: string;
  setToken: (value: string) => void;
  savedToken: string;
  client: DaemonClient;
  hello: DaemonHello | null;
  knownProjects: KnownProject[];
  isConnected: boolean;
  busy: boolean;
  daemonSummary: string;
  pairedDevices: PairedDeviceSummary[];
  manualPairingOpen: boolean;
  setManualPairingOpen: (value: boolean) => void;
  devicesOpen: boolean;
  setDevicesOpen: (value: boolean) => void;
  /** Inkrementuje po každém úspěšném refresh — konzumenti si na to navážou useEffect. */
  connectionVersion: number;
  refresh: () => Promise<void>;
  saveToken: () => Promise<void>;
  pairAutomatically: () => Promise<void>;
  disconnect: () => void;
  revokeDevice: (tokenHash: string) => Promise<void>;
  toast: string;
  showToast: (message: string) => void;
}

const DaemonContext = createContext<DaemonContextValue | null>(null);

interface DaemonProviderProps {
  telemetryApiEndpoint: string;
  children: ReactNode;
}

export function DaemonProvider({ telemetryApiEndpoint, children }: DaemonProviderProps) {
  const [token, setToken] = useState("");
  const [savedToken, setSavedToken] = useState("");
  const [hello, setHello] = useState<DaemonHello | null>(null);
  const [knownProjects, setKnownProjects] = useState<KnownProject[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [daemonSummary, setDaemonSummary] = useState("Lokální služba zatím nebyla zkontrolována.");
  const [pairedDevices, setPairedDevices] = useState<PairedDeviceSummary[]>([]);
  const [manualPairingOpen, setManualPairingOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [toast, setToast] = useState("");

  useEffect(() => {
    const stored = window.localStorage.getItem(tokenStorageKey) ?? "";
    if (stored) {
      setToken(stored);
      setSavedToken(stored);
    }
  }, []);

  const normalizedToken = savedToken.trim();
  const client = useMemo(() => new DaemonClient(normalizedToken), [normalizedToken]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await listPairedDevices();
      setPairedDevices(devices);
    } catch {
      // tichá chyba — UI ukáže prázdný seznam
    }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const activeClient = new DaemonClient(normalizedToken);
      const helloResult = await activeClient.hello();
      setHello(helloResult);
      setKnownProjects(helloResult.knownProjects ?? []);

      if (!normalizedToken) {
        setIsConnected(false);
        setDaemonSummary(`Služba běží v ${helloResult.claudeHome}. Pro zobrazení stavu ji spárujte.`);
        return;
      }

      void registerPairedDevice({
        tokenHash: await sha256(normalizedToken),
        label: deviceLabel(helloResult.claudeHome),
        claudeHome: helloResult.claudeHome
      }).catch(() => undefined);

      // Auto-on telemetrie po pairingu — daemon zapíše OTLP env do
      // ~/.claude/settings.json a Claude Code od příštího startu exportuje
      // metriky na lokální receiver.
      if (telemetryApiEndpoint && helloResult.capabilities?.includes("telemetry-export")) {
        void activeClient.enableTelemetry(telemetryApiEndpoint).catch(() => undefined);
      }

      setIsConnected(true);
      setDaemonSummary(`Připojeno k Claude Code v ${helloResult.claudeHome}.`);
      setConnectionVersion((value) => value + 1);
    } catch (error) {
      setIsConnected(false);
      setHello(null);
      setKnownProjects([]);
      setDaemonSummary(error instanceof Error ? error.message : "Lokální služba je nedostupná.");
    } finally {
      setBusy(false);
    }
  }, [normalizedToken, telemetryApiEndpoint]);

  // Auto-refresh při změně savedToken.
  useEffect(() => {
    if (!normalizedToken) {
      return;
    }
    void refresh();
  }, [normalizedToken, refresh]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices, isConnected]);

  const saveToken = useCallback(async () => {
    const nextToken = token.trim();
    setToken(nextToken);
    setSavedToken(nextToken);
    window.localStorage.setItem(tokenStorageKey, nextToken);
  }, [token]);

  const pairAutomatically = useCallback(async () => {
    setBusy(true);
    try {
      await new DaemonClient("").hello();
    } catch (error) {
      setBusy(false);
      showToast(error instanceof Error ? error.message : "Lokální služba není dostupná.");
      return;
    }
    setBusy(false);
    const returnUrl = `${window.location.origin}/pair/complete`;
    window.location.href = `${daemonOrigin}/pair?returnUrl=${encodeURIComponent(returnUrl)}`;
  }, [showToast]);

  const disconnect = useCallback(() => {
    window.localStorage.removeItem(tokenStorageKey);
    setToken("");
    setSavedToken("");
    setHello(null);
    setKnownProjects([]);
    setIsConnected(false);
    setDaemonSummary("Zařízení je odpojené. Pro lokální stav ho znovu spárujte.");
  }, []);

  const revokeDevice = useCallback(
    async (tokenHash: string) => {
      await revokePairedDevice(tokenHash);
      await refreshDevices();
      showToast("Spárování zařízení bylo zrušeno.");
    },
    [refreshDevices, showToast]
  );

  const value = useMemo<DaemonContextValue>(
    () => ({
      token,
      setToken,
      savedToken,
      client,
      hello,
      knownProjects,
      isConnected,
      busy,
      daemonSummary,
      pairedDevices,
      manualPairingOpen,
      setManualPairingOpen,
      devicesOpen,
      setDevicesOpen,
      connectionVersion,
      refresh,
      saveToken,
      pairAutomatically,
      disconnect,
      revokeDevice,
      toast,
      showToast
    }),
    [
      token,
      savedToken,
      client,
      hello,
      knownProjects,
      isConnected,
      busy,
      daemonSummary,
      pairedDevices,
      manualPairingOpen,
      devicesOpen,
      connectionVersion,
      refresh,
      saveToken,
      pairAutomatically,
      disconnect,
      revokeDevice,
      toast,
      showToast
    ]
  );

  return <DaemonContext.Provider value={value}>{children}</DaemonContext.Provider>;
}

export function useDaemon(): DaemonContextValue {
  const context = useContext(DaemonContext);
  if (!context) {
    throw new Error("useDaemon must be used within a DaemonProvider.");
  }
  return context;
}

async function sha256(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deviceLabel(claudeHome: string): string {
  const trimmed = claudeHome.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return "Tento počítač";
  return segments.slice(-2).join("/");
}
