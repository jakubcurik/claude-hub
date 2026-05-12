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
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as SessionResponse;
  return payload.user;
}

export async function loginWithEmail(email: string) {
  const response = await fetch(`${hubApiUrl()}/v1/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ email })
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<LoginResponse> & {
    message?: string;
    error?: string;
  };

  if (!response.ok || !payload.sessionToken || !payload.expiresAt || !payload.user) {
    throw new Error(payload.message || payload.error || "Přihlášení se nepodařilo.");
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
      headers: {
        authorization: `Bearer ${token}`
      }
    }).catch(() => undefined);
  }

  const cookieStore = await cookies();
  cookieStore.delete(sessionCookieName);
}
