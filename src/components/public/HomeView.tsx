"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BagIcon, SearchIcon } from "@/components/public/icons";
import { useSelection } from "@/components/public/SelectionProvider";
import { useTaxonomy } from "@/components/public/PublicShell";
import { publicAssetUrl } from "@/lib/admin/api";
import type { ApiProduct } from "@/lib/admin/types";
import {
  formatSoles,
  lampShort,
  productCategory,
  publicApi,
  waLink
} from "@/lib/public/catalog";

const CATEGORIES = ["Todas", "Tradicional", "Gel sin lámpara", "Semipermanente"];

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
  const { waNum } = useTaxonomy();
  const [products, setProducts] = useState<ApiProduct[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [brand, setBrand] = useState("Todas");
  const [category, setCategory] = useState("Todas");
  const [brandOpen, setBrandOpen] = useState(false);
  const [favs, setFavs] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    publicApi
      .listProducts()
      .then((items) => {
        if (!cancelled) {
          setProducts(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProducts([]);
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (searchParams.get("enfocar") === "busqueda") {
      const input = searchRef.current;

      if (input) {
        window.scrollTo({
          top: Math.max(0, input.getBoundingClientRect().top + window.scrollY - 120),
          behavior: "smooth"
        });
        input.focus();
      }
    }
  }, [searchParams]);

  const brands = useMemo(() => {
    const names = new Set<string>();

    for (const product of products ?? []) {
      if (product.brand?.name) {
        names.add(product.brand.name);
      }
    }

    return ["Todas", ...names];
  }, [products]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();

    return (products ?? []).filter((product) => {
      if (brand !== "Todas" && product.brand?.name !== brand) {
        return false;
      }

      if (category !== "Todas" && productCategory(product) !== category) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack =
        `${product.brand?.name ?? ""} ${product.name} ${product.product_type} ${product.presentation}`.toLowerCase();

      return haystack.includes(query);
    });
  }, [products, search, brand, category]);

  const brandActive = brand !== "Todas";
  const waConsulta = waLink(waNum, "Hola Bellaroshé, quisiera hacer una consulta.");

  return (
    <div className="br-fade" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <div className="pub-hero">
        <button
          type="button"
          className="pub-hero-sel"
          title="Mi selección"
          onClick={() => router.push("/seleccion")}
        >
          <BagIcon size={20} stroke="#4B2A3C" />
          {units > 0 ? <span className="pub-count">{units}</span> : null}
        </button>
        <Image
          src="/brand/logo-hero.png"
          alt="Importaciones Bellaroshé"
          width={228}
          height={139}
          className="pub-hero-logo"
          priority
        />
        <div className="pub-kicker">IMPORTACIONES BELLAROSHÉ · LIMA, PERÚ</div>
        <h1 className="pub-h1">
          Esmaltes de marca,
          <br />a precio de importador
        </h1>
        <div className="pub-hero-sub">
          Las marcas que aman las manicuristas del Perú, listas para entregar. Compra por unidad o
          lleva por mayor — mezcla tonos y marcas como quieras.
        </div>
        <div className="pub-hero-ctas">
          <button
            type="button"
            className="pub-cta-primary"
            onClick={() =>
              gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            Explorar esmaltes
          </button>
          <a href={waLink(waNum, "Hola Bellaroshé, quisiera asesoría para elegir esmaltes.")} target="_blank" rel="noopener" className="pub-cta-ghost">
            Pedir asesoría
          </a>
        </div>
      </div>

      <div className="pub-benefits">
        <div className="pub-benefits-row">
          <div className="pub-benefit">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#B8863B" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 8l-9-5-9 5 9 5 9-5z" />
              <path d="M3 8v8l9 5 9-5V8" />
              <path d="M12 13v8" />
            </svg>
            <div>
              <div className="pub-benefit-title">Precio por mayor</div>
              <div className="pub-benefit-sub">desde 3 unidades, mezcla tonos</div>
            </div>
          </div>
          <div className="pub-benefit-sep" />
          <div className="pub-benefit">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#C4327E" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3a9 9 0 0 1 0 18" />
              <circle cx="12" cy="8" r="1" />
              <circle cx="8" cy="12" r="1" />
              <circle cx="12" cy="16" r="1" />
            </svg>
            <div>
              <div className="pub-benefit-title">Set completo de colores</div>
              <div className="pub-benefit-sub">o los tonos que tú elijas</div>
            </div>
          </div>
          <div className="pub-benefit-sep" />
          <div className="pub-benefit">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#7C4FA8" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="6" width="14" height="11" rx="2" />
              <path d="M15 10h4l3 3v4h-7z" />
              <circle cx="6" cy="19" r="1.6" />
              <circle cx="18" cy="19" r="1.6" />
            </svg>
            <div>
              <div className="pub-benefit-title">Envíos a todo el Perú</div>
              <div className="pub-benefit-sub">y tienda física en Lima</div>
            </div>
          </div>
        </div>
      </div>

      <div className="pub-filters" id="esmaltes" ref={gridRef}>
        <div className="pub-search-row">
          <div className="pub-search">
            <SearchIcon />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar esmalte, marca o línea…"
            />
          </div>
          <div className="pub-brandwrap">
            <button
              type="button"
              className={brandActive ? "pub-brandbtn pub-brandbtn--active" : "pub-brandbtn"}
              onClick={() => setBrandOpen((open) => !open)}
            >
              {brandActive ? brand : "Marca"}
              <span style={{ fontSize: 9 }}>▾</span>
            </button>
            {brandOpen ? (
              <div className="pub-dropdown">
                {brands.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={
                      brand === name
                        ? "pub-dropdown-item pub-dropdown-item--active"
                        : "pub-dropdown-item"
                    }
                    onClick={() => {
                      setBrand(name);
                      setBrandOpen(false);
                    }}
                  >
                    {name}
                    <span className="pub-dropdown-check">{brand === name ? "✓" : ""}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="pub-chiprow">
          {CATEGORIES.map((name) => (
            <button
              key={name}
              type="button"
              className={category === name ? "chip chip--active" : "chip"}
              onClick={() => setCategory(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="pub-listhead">
        <div className="pub-listhead-left">
          <div className="pub-listhead-title">Esmaltes</div>
          <div className="pub-listhead-count">
            {products === null
              ? "cargando…"
              : `${filtered.length} ${filtered.length === 1 ? "producto" : "productos"}`}
          </div>
        </div>
        <div className="pub-original">✦ Marcas 100% originales</div>
      </div>

      {products === null ? (
        <div className="loading-block" style={{ marginBottom: 40 }}>
          <span className="spinner spinner--pink" /> Cargando catálogo…
        </div>
      ) : null}

      {products !== null && filtered.length === 0 ? (
        <div className="pub-noresults">
          <div className="empty-title">{failed ? "No pudimos cargar el catálogo" : "Sin resultados"}</div>
          <div className="empty-sub">
            {failed
              ? "Revisa tu conexión e inténtalo de nuevo."
              : "No encontramos productos con esos filtros."}
          </div>
          <button
            type="button"
            className="pub-clear"
            onClick={() => {
              if (failed) {
                window.location.reload();
                return;
              }

              setSearch("");
              setBrand("Todas");
              setCategory("Todas");
            }}
          >
            {failed ? "Reintentar" : "Limpiar filtros"}
          </button>
        </div>
      ) : null}

      <div className="pub-grid">
        {filtered.map((product) => {
          const soldOut = product.availability === "sold_out";
          const fav = favs.includes(product.id);

          return (
            <div key={product.id} className="pub-card">
              <div className="pub-card-imgwrap">
                <div className="pub-card-img" onClick={() => router.push(`/producto/${product.slug}`)}>
                  {product.main_image_path ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={publicAssetUrl(product.main_image_path)} alt={product.name} loading="lazy" />
                  ) : (
                    "Foto en camino"
                  )}
                </div>
                <button
                  type="button"
                  title="Favorito"
                  onClick={() =>
                    setFavs((current) =>
                      fav ? current.filter((id) => id !== product.id) : [...current, product.id]
                    )
                  }
                  style={{
                    position: "absolute",
                    top: 9,
                    right: 9,
                    width: 31,
                    height: 31,
                    borderRadius: "50%",
                    border: "none",
                    background: "rgba(255,255,255,.94)",
                    boxShadow: "0 4px 12px rgba(160,80,120,.18)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center"
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={fav ? "#E23E93" : "none"} stroke="#D43A8A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 21s-7-4.6-9.2-8.4C1.3 9.6 2.6 6 6 6c2 0 3.2 1.2 4 2.3C10.8 7.2 12 6 14 6c3.4 0 4.7 3.6 3.2 6.6C19 16.4 12 21 12 21z" />
                  </svg>
                </button>
              </div>
              <div className="pub-card-body" onClick={() => router.push(`/producto/${product.slug}`)}>
                <div className="pub-card-toprow">
                  <span className="pub-card-brand">{(product.brand?.name ?? "").toUpperCase()}</span>
                  {soldOut ? (
                    <span className="pub-agotado">Agotado</span>
                  ) : (
                    <span className="pub-dot-disp" title="Disponible" />
                  )}
                </div>
                <div className="pub-card-name">{product.name}</div>
                <div className="pub-card-meta">
                  {product.presentation} · {lampShort(product)}
                </div>
                <div className="pub-card-pricerow">
                  <div className="pub-card-prices">
                    <span className="pub-card-u">{formatSoles(product.unit_price)}</span>
                    <span className="pub-card-m">Mayor {formatSoles(product.wholesale_price)}</span>
                  </div>
                  <span className="pub-card-go">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#FFFDF8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="pub-tienda">
        <div className="pub-tienda-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B84A7C" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
            <circle cx="12" cy="10" r="2.6" />
          </svg>
        </div>
        <div className="pub-tienda-text">
          <b>Visítanos: tienda física en Lima, Perú</b>
          <br />
          <span style={{ color: "var(--br-muted)" }}>Envíos a todo el país · </span>
          <a
            href={waLink(
              waNum,
              "Hola Bellaroshé, quisiera la dirección y horario de la tienda física, y consultar cobertura de envíos."
            )}
            target="_blank"
            rel="noopener"
          >
            consulta dirección y cobertura
          </a>
        </div>
      </div>

      <div className="pub-otros">
        <div className="pub-otros-title">¿Buscas algo más para tu salón?</div>
        <div className="pub-otros-sub">
          También importamos accesorios de manicura y nuevas líneas cada temporada. Cuéntanos qué
          necesitas.
        </div>
        <a
          href={waLink(waNum, "Hola Bellaroshé, quisiera saber qué otros productos y novedades tienen disponibles.")}
          target="_blank"
          rel="noopener"
          className="pub-otros-btn"
        >
          Consultar novedades
        </a>
      </div>

      <div className="pub-pagos">
        <div className="pub-pagos-title">PAGA COMO PREFIERAS</div>
        <div className="pub-pagos-row">
          {PAGOS.map((pago) => (
            <div key={pago.alt} className="pub-pago">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pago.src} alt={pago.alt} loading="lazy" />
            </div>
          ))}
        </div>
        <div className="pub-pagos-note">Tu asesor te envía los datos de pago en la conversación.</div>
      </div>

      <div className="pub-footer">
        Importaciones Bellaroshé · Belleza premium por mayor y menor · Lima, Perú
        <br />
        <a href={waConsulta} target="_blank" rel="noopener">
          WhatsApp +51 963 463 550
        </a>{" "}
        · <a href="/admin">Acceso administrador</a>
      </div>
    </div>
  );
}
