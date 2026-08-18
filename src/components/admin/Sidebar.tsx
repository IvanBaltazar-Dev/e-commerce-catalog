"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  areaActiva,
  areasVisibles,
  inicioSegunRol,
  type PanelRole
} from "@/lib/admin/navigation";

// El panel lateral sustituye a la barra superior. Cambia la forma, no la
// arquitectura: los ocho dominios, el recorte por rol y las rutas siguen donde
// estaban, en @/lib/admin/navigation.
//
// Cuatro comportamientos se conservan porque costó resolverlos y siguen siendo
// correctos aquí:
//
//   · la carga ocurre bajo intención, nunca al pintar. Un lateral siempre
//     visible tiene más superficie de contacto que una barra, así que precargar
//     de golpe sería peor, no igual;
//   · un dominio sin entradas visibles no se dibuja;
//   · el segundo nivel solo existe donde hay dónde profundizar. En un lateral
//     eso es el área abierta mostrando sus entradas, no otra barra;
//   · dónde estás se deduce de la ruta, no de lo último que se pulsó.
//
// En móvil el lateral es un cajón. Se abre desde la cabecera, se cierra al
// navegar, con Escape o tocando fuera, y devuelve el foco al botón que lo
// abrió.

export function Sidebar({ role }: { role: PanelRole }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const areas = areasVisibles(role);
  const activa = areaActiva(areas, pathname);
  const inicio = inicioSegunRol(role);
  const navigationPending = Boolean(pendingHref && !pathname.startsWith(pendingHref));

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    toggleRef.current?.focus();
  }, []);

  // La ruta cambió: el cajón ya cumplió su función y estorba.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeDrawer();
    }
    document.addEventListener("keydown", onKey);
    drawerRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);

  function intent(href: string) {
    router.prefetch(href);
  }

  function beginNavigation(href: string) {
    if (!pathname.startsWith(href)) setPendingHref(href);
  }

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.replace("/admin/login");
    router.refresh();
  }

  function linkProps(href: string) {
    return {
      prefetch: false as const,
      onPointerEnter: () => intent(href),
      onFocus: () => intent(href),
      onClick: () => beginNavigation(href)
    };
  }

  const nav = (
    <nav className="side-nav" aria-label="Secciones del panel">
      {areas.map((area) => {
        const abierta = area.id === activa?.id;
        const principal = area.entradas[0];
        return (
          <div key={area.id} className={abierta ? "side-area side-area--open" : "side-area"}>
            <Link
              href={principal.href}
              className={abierta ? "side-item side-item--active" : "side-item"}
              aria-current={abierta && area.entradas.length === 1 ? "page" : undefined}
              {...linkProps(principal.href)}
            >
              {area.label}
            </Link>

            {abierta && area.entradas.length > 1 ? (
              <div className="side-sublist">
                {area.entradas.map((entrada) => {
                  const aqui = pathname.startsWith(entrada.href);
                  return (
                    <Link
                      key={entrada.href}
                      href={entrada.href}
                      className={aqui ? "side-sub side-sub--active" : "side-sub"}
                      aria-current={aqui ? "page" : undefined}
                      {...linkProps(entrada.href)}
                    >
                      {entrada.label}
                    </Link>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );

  const pie = (
    <div className="side-foot">
      <Link href="/" className="side-foot-link" target="_blank">
        Ver catálogo ↗
      </Link>
      <button type="button" className="btn-ghost side-foot-exit" onClick={handleLogout}>
        Salir
      </button>
    </div>
  );

  return (
    <>
      {/* Cabecera compacta: solo existe donde el lateral no cabe. */}
      <header className="side-topbar">
        <button
          ref={toggleRef}
          type="button"
          className="side-burger"
          aria-expanded={drawerOpen}
          aria-controls="panel-cajon"
          onClick={() => setDrawerOpen(true)}
        >
          <span aria-hidden="true" className="side-burger-lines" />
          <span className="sr-only">Abrir las secciones</span>
        </button>
        <Link href={inicio} aria-label="Ir al inicio" {...linkProps(inicio)}>
          <Image src="/brand/logo-sm.png" alt="Bellaroshé" width={58} height={36} priority />
        </Link>
        <span className="side-topbar-area">{activa?.label ?? "Administración"}</span>
      </header>

      <aside
        id="panel-cajon"
        ref={drawerRef}
        tabIndex={-1}
        className={`side-rail${drawerOpen ? " side-rail--open" : ""}`}
        aria-label="Navegación del panel"
      >
        {navigationPending ? <span className="side-progress" aria-label="Cargando sección" /> : null}

        <div className="side-head">
          <Link href={inicio} className="side-brand" aria-label="Ir al inicio" {...linkProps(inicio)}>
            <Image src="/brand/logo-sm.png" alt="Bellaroshé" width={64} height={40} priority />
            <span className="side-brand-text">Administración</span>
          </Link>
          <button type="button" className="side-close" onClick={closeDrawer}>
            <span aria-hidden="true">✕</span>
            <span className="sr-only">Cerrar las secciones</span>
          </button>
        </div>

        {nav}
        {pie}
      </aside>

      {drawerOpen ? (
        <button
          type="button"
          className="side-backdrop"
          aria-label="Cerrar las secciones"
          onClick={closeDrawer}
        />
      ) : null}
    </>
  );
}
