"use client";

import { useActionState } from "react";
import { registerAction, type AuthFormState } from "@/app/actions";

const initialState: AuthFormState = {};

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(registerAction, initialState);

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
      <label htmlFor="password">Heslo (alespoň 8 znaků)</label>
      <input
        autoComplete="new-password"
        id="password"
        minLength={8}
        name="password"
        placeholder="••••••••"
        required
        type="password"
      />
      <label htmlFor="registryCode">Registrační kód</label>
      <input
        autoComplete="off"
        id="registryCode"
        name="registryCode"
        placeholder="Kód, který vám předal správce"
        required
        type="text"
      />
      {state.error ? <p className="login-error">{state.error}</p> : null}
      <button className="primary" disabled={pending} type="submit">
        {pending ? "Vytvářím účet..." : "Vytvořit účet"}
      </button>
    </form>
  );
}
