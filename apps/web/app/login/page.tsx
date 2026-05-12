import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions";
import { getCurrentUser } from "@/lib/hub-auth";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/");
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-block">
          <div className="brand-mark">CH</div>
          <div>
            <strong>Claude Hub</strong>
            <span>Katalog pro tým</span>
          </div>
        </div>
        <form action={loginAction} className="login-form">
          <label htmlFor="email">E-mail</label>
          <input autoComplete="email" id="email" name="email" placeholder="jmeno@example.com" required type="email" />
          <button className="primary" type="submit">
            Pokračovat
          </button>
        </form>
      </section>
    </main>
  );
}
