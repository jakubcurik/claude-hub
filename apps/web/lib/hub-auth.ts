import { cookies } from "next/headers";

export interface HubUser {
  id: string;
  email: string;
  name: string;
  defaultTeamId: string;
}

interface LoginResponse {
  user: HubUser;
  sessionToken: string;
  expiresAt: string;
}

interface SessionResponse {
  user: HubUser;
}

export const sessionCookieName = "claude_hub_session";

export function hubApiUrl() {
  const apiUrl = process.env.CLAUDE_HUB_API_URL;
  if (!apiUrl) {
    throw new Error("Claude Hub API není nastavené. Doplňte CLAUDE_HUB_API_URL.");
  }
  return apiUrl;
}

export function hubTeamId() {
  return process.env.CLAUDE_HUB_TEAM_ID ?? "main";
}

export function hubTeamName() {
  return process.env.CLAUDE_HUB_TEAM_NAME ?? "Tým";
}

export async function getSessionToken() {
  const cookieStore = await cookies();
  return cookieStore.get(sessionCookieName)?.value ?? "";
}

export async function getCurrentUser(): Promise<HubUser | null> {
  const token = await getSessionToken();
  if (!token) {
    return null;
  }

  const response = await fetch(`${hubApiUrl()}/v1/auth/session`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as SessionResponse;
  return payload.user;
}

export async function loginWithEmail(email: string, password: string) {
  return submitAuth("/v1/auth/login", { email, password });
}

export async function registerWithEmail(email: string, password: string, registryCode: string) {
  return submitAuth("/v1/auth/register", { email, password, registryCode });
}

async function submitAuth(path: string, body: Record<string, string>) {
  const response = await fetch(`${hubApiUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<LoginResponse> & {
    message?: string;
    error?: string;
  };

  if (!response.ok || !payload.sessionToken || !payload.expiresAt || !payload.user) {
    throw new Error(payload.message || payload.error || "Operace se nezdařila.");
  }

  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName, payload.sessionToken, {
    expires: new Date(payload.expiresAt),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });

  return payload.user;
}

export async function clearCurrentSession() {
  const token = await getSessionToken();
  if (token) {
    await fetch(`${hubApiUrl()}/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    }).catch(() => undefined);
  }

  const cookieStore = await cookies();
  cookieStore.delete(sessionCookieName);
}

export async function hubFetch<T>(path: string, init?: RequestInit & { jsonBody?: unknown }): Promise<T> {
  const token = await getSessionToken();
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined)
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (init?.jsonBody !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${hubApiUrl()}${path}`, {
    ...init,
    headers,
    body: init?.jsonBody !== undefined ? JSON.stringify(init.jsonBody) : init?.body,
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(payload.message || payload.error || `API request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}
