import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/hub-auth";
import { LoginForm } from "./login-form";

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
        <LoginForm />
        <p className="login-footnote">
          Nemáte ještě účet? <Link href="/register">Registrace</Link>
        </p>
      </section>
    </main>
  );
}
