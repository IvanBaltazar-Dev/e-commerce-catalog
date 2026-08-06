"use client";
/* eslint-disable @next/next/no-img-element */

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PremiumPagination } from "@/components/PremiumPagination";
import { BagIcon, SearchIcon } from "@/components/public/icons";
import { useSelection } from "@/components/public/SelectionProvider";
import { useTaxonomy } from "@/components/public/PublicShell";
import { publicAssetUrl } from "@/lib/admin/api";
import type { CatalogListResponse } from "@/lib/catalog/contracts";
import { formatSoles, publicApi, waLink } from "@/lib/public/catalog";

const PUBLIC_PAGE_SIZE = 15;

const PAGOS = [
  { src: "/pagos/yape.jpg", alt: "Yape" },
  { src: "/pagos/plin.jpg", alt: "Plin" },
  { src: "/pagos/bcp.jpg", alt: "BCP" },
  { src: "/pagos/bbva.jpg", alt: "BBVA" },
  { src: "/pagos/interbank.png", alt: "Interbank" }
];

export function HomeView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { units } = useSelection();
  const { taxonomy, waNum } = useTaxonomy();
  const [catalog, setCatalog] = useState<CatalogListResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [brandOpen, setBrandOpen] = useState(false);
  const [favs, setFavs] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, brand, category]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    publicApi
      .listProducts({
        page,
        pageSize: PUBLIC_PAGE_SIZE,
        search: debouncedSearch || undefined,
        brand: brand || undefined,
        category: category || undefined
      })
      .then((response) => {
        if (!cancelled) setCatalog(response);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setCatalog(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, debouncedSearch, brand, category]);

  useEffect(() => {
    if (searchParams.get("enfocar") !== "busqueda") return;
    const input = searchRef.current;
    if (!input) return;

    window.scrollTo({
      top: Math.max(0, input.getBoundingClientRect().top + window.scrollY - 120),
      behavior: "smooth"
    });
    input.focus();
  }, [searchParams]);

  const brands = taxonomy?.brands ?? [];
  const categories = useMemo(
    () => (taxonomy?.categories ?? []).filter((item) => item.depth <= 1),
    [taxonomy]
  );

  function changePage(nextPage: number) {
    setPage(nextPage);
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function clearFilters() {
    setSearch("");
    setBrand("");
    setCategory("");
  }

  const activeBrandName = brands.find((item) => item.slug === brand)?.name;
  const waConsulta = waLink(waNum, "Hola Bellaroshé, quisiera hacer una consulta.");
  const items = catalog?.items ?? [];

  return (
    <div className="br-fade" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <div className="pub-hero">
        <button type="button" className="pub-hero-sel" title="Mi selección" onClick={() => router.push("/seleccion")}>
          <BagIcon size={20} stroke="#4B2A3C" />
          {units > 0 ? <span className="pub-count">{units}</span> : null}
        </button>
        <Image src="/brand/logo-hero.png" alt="Importaciones Bellaroshé" width={228} height={139} className="pub-hero-logo" priority />
        <div className="pub-kicker">IMPORTACIONES BELLAROSHÉ · LIMA, PERÚ</div>
        <h1 className="pub-h1">Belleza profesional,<br />a precio de importador</h1>
        <div className="pub-hero-sub">
          Esmaltes, extensiones, máquinas y accesorios para tu salón. Compra por variante o consulta una cotización especializada.
        </div>
        <div className="pub-hero-ctas">
          <button type="button" className="pub-cta-primary" onClick={() => gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            Explorar catálogo
          </button>
          <a href={waLink(waNum, "Hola Bellaroshé, quisiera asesoría para elegir productos.")} target="_blank" rel="noopener" className="pub-cta-ghost">
            Pedir asesoría
          </a>
        </div>
      </div>

      <div className="pub-benefits">
        <div className="pub-benefits-row">
          <div className="pub-benefit"><div><div className="pub-benefit-title">Precio por mayor</div><div className="pub-benefit-sub">reglas calculadas por producto</div></div></div>
          <div className="pub-benefit-sep" />
          <div className="pub-benefit"><div><div className="pub-benefit-title">Variantes reales</div><div className="pub-benefit-sub">tonos, medidas y combinaciones</div></div></div>
          <div className="pub-benefit-sep" />
          <div className="pub-benefit"><div><div className="pub-benefit-title">Envíos a todo el Perú</div><div className="pub-benefit-sub">y tienda física en Lima</div></div></div>
        </div>
      </div>

      <div className="pub-filters" id="catalogo" ref={gridRef}>
        <div className="pub-search-row">
          <div className="pub-search">
            <SearchIcon />
            <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar producto, SKU, marca o categoría…" />
          </div>
          <div className="pub-brandwrap">
            <button type="button" className={brand ? "pub-brandbtn pub-brandbtn--active" : "pub-brandbtn"} onClick={() => setBrandOpen((open) => !open)}>
              {activeBrandName ?? "Marca"}<span style={{ fontSize: 9 }}>▾</span>
            </button>
            {brandOpen ? (
              <div className="pub-dropdown">
                <button type="button" className={!brand ? "pub-dropdown-item pub-dropdown-item--active" : "pub-dropdown-item"} onClick={() => { setBrand(""); setBrandOpen(false); }}>
                  Todas<span className="pub-dropdown-check">{!brand ? "✓" : ""}</span>
                </button>
                {brands.map((item) => (
                  <button key={item.id} type="button" className={brand === item.slug ? "pub-dropdown-item pub-dropdown-item--active" : "pub-dropdown-item"} onClick={() => { setBrand(item.slug); setBrandOpen(false); }}>
                    {item.name}<span className="pub-dropdown-check">{brand === item.slug ? "✓" : ""}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="pub-chiprow">
          <button type="button" className={!category ? "chip chip--active" : "chip"} onClick={() => setCategory("")}>Todas</button>
          {categories.map((item) => (
            <button key={item.id} type="button" className={category === item.path ? "chip chip--active" : "chip"} onClick={() => setCategory(item.path)}>
              {item.depth ? `↳ ${item.name}` : item.name}
            </button>
          ))}
        </div>
      </div>

      <div className="pub-listhead" ref={listRef}>
        <div className="pub-listhead-left">
          <div className="pub-listhead-title">Catálogo</div>
          <div className="pub-listhead-count">{loading && !catalog ? "cargando…" : `${catalog?.totalItems ?? 0} productos`}</div>
        </div>
        <div className="pub-original">✦ Datos y disponibilidad actualizados</div>
      </div>

      {loading && !catalog ? <div className="loading-block" style={{ marginBottom: 40 }}><span className="spinner spinner--pink" /> Cargando catálogo…</div> : null}

      {!loading && (failed || items.length === 0) ? (
        <div className="pub-noresults">
          <div className="empty-title">{failed ? "No pudimos cargar el catálogo" : "Sin resultados"}</div>
          <div className="empty-sub">{failed ? "La consulta local falló. Reintenta en unos segundos." : "No encontramos productos con esos filtros."}</div>
          <button type="button" className="pub-clear" onClick={failed ? () => window.location.reload() : clearFilters}>{failed ? "Reintentar" : "Limpiar filtros"}</button>
        </div>
      ) : null}

      <div className="pub-grid" aria-busy={loading}>
        {items.map((product) => {
          const fav = favs.includes(product.productId);
          const soldOut = product.availabilitySummary.available === 0 && product.availabilitySummary.consult === 0;
          const consultOnly = product.startingPrice === null && product.availabilitySummary.consult > 0;

          return (
            <article key={product.productId} className="pub-card">
              <div className="pub-card-img" onClick={() => router.push(`/producto/${product.slug}`)}>
                {product.mainImage ? (
                  <img src={publicAssetUrl(product.mainImage)} alt={product.name} loading="lazy" />
                ) : <span>Foto en camino</span>}
                <button type="button" aria-label={fav ? "Quitar de favoritos" : "Agregar a favoritos"} onClick={(event) => { event.stopPropagation(); setFavs((current) => fav ? current.filter((id) => id !== product.productId) : [...current, product.productId]); }} style={{ position: "absolute", top: 9, right: 9, width: 31, height: 31, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.94)", cursor: "pointer" }}>
                  <span style={{ color: "#D43A8A" }}>{fav ? "♥" : "♡"}</span>
                </button>
              </div>
              <div className="pub-card-body" onClick={() => router.push(`/producto/${product.slug}`)}>
                <div className="pub-card-toprow">
                  <span className="pub-card-brand">{product.brand.name.toUpperCase()}</span>
                  {soldOut ? <span className="pub-agotado">Agotado</span> : consultOnly ? <span className="pub-agotado">Consultar</span> : <span className="pub-dot-disp" title="Disponible" />}
                </div>
                <div className="pub-card-name">{product.name}</div>
                <div className="pub-card-meta">
                  {product.category.name}{product.hasMultipleVariants ? ` · ${product.featuredVariant.name}` : ` · SKU ${product.featuredVariant.sku}`}
                </div>
                <div className="pub-card-pricerow">
                  <div className="pub-card-prices">
                    <span className="pub-card-u">{formatSoles(product.startingPrice)}</span>
                    {product.priceRange.min !== product.priceRange.max && product.priceRange.max !== null ? <span className="pub-card-m">hasta {formatSoles(product.priceRange.max)}</span> : null}
                  </div>
                  <span className="pub-card-go">→</span>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {catalog && catalog.totalPages > 1 ? <PremiumPagination currentPage={catalog.page} totalPages={catalog.totalPages} onPageChange={changePage} tone="public" /> : null}

      <div className="pub-tienda"><div className="pub-tienda-text"><b>Visítanos: tienda física en Lima, Perú</b><br /><span style={{ color: "var(--br-muted)" }}>Envíos a todo el país · </span><a href={waLink(waNum, "Hola Bellaroshé, quisiera la dirección, horario y cobertura de envíos.")} target="_blank" rel="noopener">consulta dirección y cobertura</a></div></div>
      <div className="pub-otros"><div className="pub-otros-title">¿Necesitas ayuda para tu salón?</div><div className="pub-otros-sub">Cuéntanos qué necesitas y un asesor revisará compatibilidad, disponibilidad y alternativas.</div><a href={waLink(waNum, "Hola Bellaroshé, quisiera asesoría para equipar mi salón.")} target="_blank" rel="noopener" className="pub-otros-btn">Hablar con un asesor</a></div>
      <div className="pub-pagos"><div className="pub-pagos-title">PAGA COMO PREFIERAS</div><div className="pub-pagos-row">{PAGOS.map((pago) => <div key={pago.alt} className="pub-pago"><img src={pago.src} alt={pago.alt} loading="lazy" /></div>)}</div><div className="pub-pagos-note">Tu asesor confirma stock, total y datos de pago en la conversación.</div></div>
      <div className="pub-footer">Importaciones Bellaroshé · Belleza profesional por mayor y menor · Lima, Perú<br /><a href={waConsulta} target="_blank" rel="noopener">WhatsApp +51 963 463 550</a> · <a href="/admin">Acceso administrador</a></div>
    </div>
  );
}
