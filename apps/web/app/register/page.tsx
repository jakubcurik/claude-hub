import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/hub-auth";
import { RegisterForm } from "./register-form";

export default async function RegisterPage() {
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
            <span>Registrace nového účtu</span>
          </div>
        </div>
        <RegisterForm />
        <p className="login-footnote">
          Už máte účet? <Link href="/login">Přihlásit se</Link>
        </p>
      </section>
    </main>
  );
}
