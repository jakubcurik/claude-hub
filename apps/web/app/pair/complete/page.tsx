"use client";

import { useEffect, useState } from "react";

const tokenStorageKey = "claudeHubDaemonToken";

export default function PairCompletePage() {
  const [message, setMessage] = useState("Dokončuji párování zařízení.");

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("daemonToken")?.trim();
    if (!token) {
      setMessage("Párování se nepodařilo dokončit. Vraťte se do Claude Hubu a zkuste to znovu.");
      return;
    }

    window.localStorage.setItem(tokenStorageKey, token);
    window.location.replace("/");
  }, []);

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-block">
          <div className="brand-mark">CH</div>
          <div>
            <strong>Claude Hub</strong>
            <span>Propojení zařízení</span>
          </div>
        </div>
        <p>{message}</p>
      </section>
    </main>
  );
}
