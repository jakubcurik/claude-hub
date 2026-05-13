"use client";

import { useActionState } from "react";
import { loginAction, type AuthFormState } from "@/app/actions";

const initialState: AuthFormState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="login-form">
      <label htmlFor="email">E-mail</label>
      <input
        autoComplete="email"
        id="email"
        name="email"
        placeholder="jmeno@example.com"
        required
        type="email"
      />
      <label htmlFor="password">Heslo</label>
      <input
        autoComplete="current-password"
        id="password"
        name="password"
        placeholder="••••••••"
        required
        type="password"
      />
      {state.error ? <p className="login-error">{state.error}</p> : null}
      <button className="primary" disabled={pending} type="submit">
        {pending ? "Přihlašuji..." : "Přihlásit"}
      </button>
    </form>
  );
}
