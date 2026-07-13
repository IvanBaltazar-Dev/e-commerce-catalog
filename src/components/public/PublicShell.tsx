"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { BagIcon, WaIcon } from "@/components/public/icons";
import { SelectionProvider, useSelection } from "@/components/public/SelectionProvider";
import { publicApi, waLink, waNumber, type PublicTaxonomy } from "@/lib/public/catalog";

type TaxonomyState = {
  taxonomy: PublicTaxonomy | null;
  waNum: string;
};

const TaxonomyContext = createContext<TaxonomyState>({ taxonomy: null, waNum: "51963463550" });

export function useTaxonomy() {
  return useContext(TaxonomyContext);
}

function DesktopHeader() {
  const router = useRouter();
  const { units } = useSelection();
  const { waNum } = useTaxonomy();

  return (
    <div className="pub-header">
      <div className="pub-header-inner">
        <Image
          src="/logo.png"
          alt="Importaciones Bellaroshé"
          width={85}
          height={52}
          className="pub-header-logo"
          onClick={() => router.push("/")}
          priority
        />
        <nav className="pub-header-nav">
          <Link href="/" className="pub-nav-link">
            Inicio
          </Link>
          <Link href="/#esmaltes" className="pub-nav-link">
            Esmaltes
          </Link>
          <a
            href={waLink(waNum, "Hola Bellaroshé, quisiera hacer una consulta.")}
            target="_blank"
            rel="noopener"
            className="pub-nav-link"
          >
            Contacto
          </a>
        </nav>
        <a
          href={waLink(waNum, "Hola Bellaroshé, quisiera hacer una consulta.")}
          target="_blank"
          rel="noopener"
          className="pub-wa-pill"
        >
          <WaIcon size={15} />
          WhatsApp
        </a>
        <button type="button" className="pub-sel-btn" onClick={() => router.push("/seleccion")}>
          <BagIcon size={16} />
          Mi selección
          {units > 0 ? <span className="pub-count">{units}</span> : null}
        </button>
      </div>
    </div>
  );
}

function MobileTabBar() {
  const router = useRouter();
  const pathname = usePathname();
  const { units } = useSelection();
  const { waNum } = useTaxonomy();

  if (pathname.startsWith("/producto/")) {
    return null;
  }

  return (
    <div className="pub-tabbar">
      <button
        type="button"
        className="pub-tab"
        onClick={() => {
          if (pathname !== "/") {
            router.push("/");
          } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 10.5L12 3l9 7.5" />
          <path d="M5 9v11h14V9" />
        </svg>
        Inicio
      </button>
      <button type="button" className="pub-tab" onClick={() => router.push("/?enfocar=busqueda")}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        Buscar
      </button>
      <button type="button" className="pub-tab" onClick={() => router.push("/#esmaltes")}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="8" height="8" rx="2" />
          <rect x="13" y="3" width="8" height="8" rx="2" />
          <rect x="3" y="13" width="8" height="8" rx="2" />
          <rect x="13" y="13" width="8" height="8" rx="2" />
        </svg>
        Esmaltes
      </button>
      <button type="button" className="pub-tab pub-tab--sel" onClick={() => router.push("/seleccion")}>
        <BagIcon size={20} />
        {units > 0 ? <span className="pub-tab-badge">{units}</span> : null}
        Mi selección
      </button>
      <a
        href={waLink(waNum, "Hola Bellaroshé, quisiera hacer una consulta.")}
        target="_blank"
        rel="noopener"
        className="pub-tab pub-tab--wa"
      >
        <WaIcon size={20} />
        WhatsApp
      </a>
    </div>
  );
}

export function PublicShell({ children }: { children: React.ReactNode }) {
  const [taxonomy, setTaxonomy] = useState<PublicTaxonomy | null>(null);

  useEffect(() => {
    let cancelled = false;

    publicApi
      .taxonomy()
      .then((data) => {
        if (!cancelled) {
          setTaxonomy(data);
        }
      })
      .catch(() => {
        // Sin taxonomía se usa el número de respaldo.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SelectionProvider>
      <TaxonomyContext.Provider value={{ taxonomy, waNum: waNumber(taxonomy) }}>
        <div className="pub-shell">
          <DesktopHeader />
          <div className="pub-main">{children}</div>
          <MobileTabBar />
        </div>
      </TaxonomyContext.Provider>
    </SelectionProvider>
  );
}
