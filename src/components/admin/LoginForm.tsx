"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

function translateAuthError(message: string) {
  if (/invalid login credentials/i.test(message)) {
    return "Correo o contraseña incorrectos. Verifica tus datos e inténtalo de nuevo.";
  }

  if (/email not confirmed/i.test(message)) {
    return "Debes confirmar tu correo antes de ingresar.";
  }

  if (/fetch|network/i.test(message)) {
    return "No se pudo conectar con el servidor. Inténtalo de nuevo en unos segundos.";
  }

  return message;
}

export function LoginForm({ initialError }: { initialError?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (loading) {
      return;
    }

    if (!email.trim() || !password.trim()) {
      setError("Ingresa tu correo y contraseña para continuar.");
      return;
    }

    setLoading(true);
    setError("");

    const supabase = getSupabaseBrowserClient();
    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password
    });

    if (authError || !data.user) {
      setError(translateAuthError(authError?.message ?? "No se pudo iniciar sesión."));
      setLoading(false);
      return;
    }

    const { data: profile } = await supabase
      .from("admin_profiles")
      .select("id")
      .eq("id", data.user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!profile) {
      await supabase.auth.signOut();
      setError("Tu usuario no tiene permisos de administrador.");
      setLoading(false);
      return;
    }

    router.replace("/admin/productos");
    router.refresh();
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <Image
          src="/logo.png"
          alt="Importaciones Bellaroshé"
          width={190}
          height={116}
          className="login-logo"
          priority
        />
        <div className="login-title">Panel de administración</div>
        <div className="login-sub">Gestiona tu catálogo, precios y PDF</div>
        <div className="login-fields">
          <div>
            <div className="field-label">Correo</div>
            <input
              type="email"
              className="input input--login"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError("");
              }}
              placeholder="admin@bellaroshe.pe"
              autoComplete="email"
            />
          </div>
          <div>
            <div className="field-label">Contraseña</div>
            <input
              type="password"
              className="input input--login"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
        </div>
        {error ? <div className="login-error">{error}</div> : null}
        <button type="submit" className="login-btn" disabled={loading}>
          {loading ? <span className="spinner" /> : null}
          {loading ? "Ingresando…" : "Iniciar sesión"}
        </button>
        <div className="login-note">
          Acceso restringido — solo administradores de Bellaroshé. Si necesitas una cuenta,
          contacta a la persona encargada del negocio.
        </div>
        <div className="login-back">
          <Link href="/">← Volver al catálogo público</Link>
        </div>
      </form>
    </div>
  );
}
