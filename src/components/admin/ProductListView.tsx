"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { PremiumPagination } from "@/components/PremiumPagination";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, formatPrice, publicAssetUrl } from "@/lib/admin/api";
import type {
  ApiPhotoCoverage,
  ApiProduct,
  ApiPublicationSplit,
  PhotoState
} from "@/lib/admin/types";

type PublicationState = "publicado" | "borrador" | "oculto";

const EDITORIAL_BADGE: Record<string, string> = {
  published: "Publicado",
  draft: "Borrador",
  in_review: "En revisión",
  incomplete: "Incompleto",
  hidden: "Oculto"
};

// El resumen es el dueño único de estos dos números y, a la vez, el control que
// filtra por ellos. Tenerlos como contador arriba y como chip aparte repetiría
// el mismo dato en dos sitios y obligaría a mantenerlos de acuerdo.
type Segment<K> = { key: K; label: string; one?: string; tone: string };

const PUBLICATION_SEGMENTS: Array<Segment<PublicationState>> = [
  { key: "publicado", label: "publicados", one: "publicado", tone: "ok" },
  { key: "borrador", label: "en borrador", tone: "pend" },
  { key: "oculto", label: "ocultos", one: "oculto", tone: "off" }
];

const PHOTO_SEGMENTS: Array<Segment<PhotoState>> = [
  { key: "con_foto", label: "con foto", tone: "ok" },
  { key: "solo_respaldo", label: "solo color", tone: "pend" },
  { key: "sin_foto", label: "sin foto", tone: "off" }
];

function segmentLabel(segment: Segment<unknown>, value: number) {
  return value === 1 && segment.one ? segment.one : segment.label;
}

const ADMIN_PAGE_SIZE = 8;
const VISIBLE_BRAND_FILTERS = 4;

const EMPTY_COVERAGE: ApiPhotoCoverage = { con_foto: 0, solo_respaldo: 0, sin_foto: 0 };
const EMPTY_PUBLICATION: ApiPublicationSplit = { publicado: 0, borrador: 0, oculto: 0 };

function formatCount(value: number) {
  return value.toLocaleString("es-PE");
}

export function ProductListView() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [products, setProducts] = useState<ApiProduct[] | null>(null);
  const [total, setTotal] = useState(0);
  const [coverage, setCoverage] = useState<ApiPhotoCoverage>(EMPTY_COVERAGE);
  const [publication, setPublication] = useState<ApiPublicationSplit>(EMPTY_PUBLICATION);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);
  const [brandFilter, setBrandFilter] = useState("Todas");
  const [stateFilter, setStateFilter] = useState<PublicationState | undefined>(undefined);
  const [photoFilter, setPhotoFilter] = useState<PhotoState | undefined>(undefined);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  // El catálogo real supera el millar de productos: la lista pide cada página
  // al servidor (búsqueda y filtros incluidos) en vez de recortar una sola
  // respuesta de 100 en el cliente.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    adminApi
      .listBrands()
      .then((items) => setBrands(items.filter((brand) => brand.is_active).map((brand) => ({ id: brand.id, name: brand.name }))))
      .catch(() => setBrands([]));
  }, []);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, brandFilter, stateFilter, photoFilter]);

  // Depender del array de marcas relanzaba la búsqueda entera cuando llegaba:
  // dos peticiones idénticas en cada carga, la segunda para descubrir que con
  // «Todas» el id sigue sin existir. Dependiendo del id —un primitivo— solo se
  // repite cuando de verdad cambia la marca elegida.
  const brandId = useMemo(
    () => brands.find((brand) => brand.name === brandFilter)?.id,
    [brands, brandFilter]
  );

  useEffect(() => {
    let cancelled = false;

    adminApi
      .listProductsPage({
        page,
        pageSize: ADMIN_PAGE_SIZE,
        q: debouncedSearch || undefined,
        estado: stateFilter,
        brandId,
        foto: photoFilter
      })
      .then((result) => {
        if (!cancelled) {
          setProducts(result.items);
          setTotal(result.total);
          setCoverage(result.cobertura ?? EMPTY_COVERAGE);
          setPublication(result.publicacion ?? EMPTY_PUBLICATION);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProducts([]);
          setTotal(0);
          setCoverage(EMPTY_COVERAGE);
          setPublication(EMPTY_PUBLICATION);
          handleApiError(error, "No se pudieron cargar los productos.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [page, debouncedSearch, brandId, stateFilter, photoFilter, handleApiError]);

  const brandChips = useMemo(() => ["Todas", ...brands.map((brand) => brand.name)], [brands]);

  const visibleBrandChips = brandChips.slice(0, VISIBLE_BRAND_FILTERS);
  const overflowBrandChips = brandChips.slice(VISIBLE_BRAND_FILTERS);
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedProducts = products ?? [];
  const hasFilters =
    Boolean(debouncedSearch) || brandFilter !== "Todas" || Boolean(stateFilter) || Boolean(photoFilter);

  // Los conteos vienen de un universo que ignora su propio filtro, así que el
  // denominador de cada barra es su propia suma y no el total de la página.
  const photoUniverse = coverage.con_foto + coverage.solo_respaldo + coverage.sin_foto;
  const publicationUniverse = publication.publicado + publication.borrador + publication.oculto;

  function changePage(nextPage: number) {
    setPage(nextPage);
    requestAnimationFrame(() => {
      rowsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function clearFilters() {
    setSearch("");
    setDebouncedSearch("");
    setBrandFilter("Todas");
    setStateFilter(undefined);
    setPhotoFilter(undefined);
  }

  async function togglePublished(product: ApiProduct) {
    if (togglingId) {
      return;
    }

    setTogglingId(product.id);
    const nextActive = !product.is_active;
    setProducts(
      (current) =>
        current?.map((item) =>
          item.id === product.id ? { ...item, is_active: nextActive } : item
        ) ?? null
    );

    try {
      await adminApi.updateProduct(product.id, { isActive: nextActive });
      showToast(
        nextActive ? `${product.name} activado ✓` : `${product.name} desactivado del catálogo`
      );
    } catch (error) {
      setProducts(
        (current) =>
          current?.map((item) =>
            item.id === product.id ? { ...item, is_active: product.is_active } : item
          ) ?? null
      );
      handleApiError(error, "No se pudo cambiar el estado del producto.");
    } finally {
      setTogglingId(null);
    }
  }

  if (products === null) {
    return (
      <div className="loading-block">
        <span className="spinner spinner--pink" /> Cargando productos…
      </div>
    );
  }

  return (
    <div className="br-fade">
      <div className="list-head">
        <div>
          <div className="page-title">Productos</div>
          <div className="page-sub">
            {hasFilters
              ? `${formatCount(total)} ${total === 1 ? "resultado" : "resultados"}`
              : `${formatCount(total)} en catálogo`}
            {" · página "}
            {currentPage} de {totalPages}
          </div>
        </div>
        <Link href="/admin/productos/nuevo" className="btn-primary">
          <span className="btn-new-icon">＋</span> Nuevo producto
        </Link>
      </div>

      {/* Cómo va el catálogo, antes de la lista. Cada número es también el
          filtro que lo aísla: un clic para ver exactamente eso. */}
      <div className="cov-panel">
        <div className="cov-line">
          <span className="cov-label">Fotos</span>
          <span className="cov-meter" aria-hidden="true">
            <span
              className="cov-meter-fill cov-meter-fill--ok"
              style={{
                width: photoUniverse
                  ? `${Math.max((coverage.con_foto / photoUniverse) * 100, coverage.con_foto ? 1.5 : 0)}%`
                  : "0%"
              }}
            />
          </span>
          <span className="cov-segments">
            {PHOTO_SEGMENTS.map((segment) => {
              const value = coverage[segment.key];

              // «Solo color» solo estorba mientras valga cero: es un estado
              // real del dominio, no una casilla que deba ocupar sitio siempre.
              if (value === 0 && segment.key === "solo_respaldo" && photoFilter !== segment.key) {
                return null;
              }

              const active = photoFilter === segment.key;
              return (
                <button
                  key={segment.key}
                  type="button"
                  aria-pressed={active}
                  className={active ? "cov-seg cov-seg--active" : "cov-seg"}
                  onClick={() => setPhotoFilter(active ? undefined : segment.key)}
                >
                  <span className={`cov-dot cov-dot--${segment.tone}`} aria-hidden="true" />
                  <strong>{formatCount(value)}</strong> {segmentLabel(segment, value)}
                </button>
              );
            })}
          </span>
        </div>

        <div className="cov-line">
          <span className="cov-label">Publicación</span>
          <span className="cov-meter" aria-hidden="true">
            <span
              className="cov-meter-fill cov-meter-fill--ok"
              style={{
                width: publicationUniverse
                  ? `${Math.max((publication.publicado / publicationUniverse) * 100, publication.publicado ? 1.5 : 0)}%`
                  : "0%"
              }}
            />
          </span>
          <span className="cov-segments">
            {PUBLICATION_SEGMENTS.map((segment) => {
              const value = publication[segment.key];
              const active = stateFilter === segment.key;
              return (
                <button
                  key={segment.key}
                  type="button"
                  aria-pressed={active}
                  className={active ? "cov-seg cov-seg--active" : "cov-seg"}
                  onClick={() => setStateFilter(active ? undefined : segment.key)}
                >
                  <span className={`cov-dot cov-dot--${segment.tone}`} aria-hidden="true" />
                  <strong>{formatCount(value)}</strong> {segmentLabel(segment, value)}
                </button>
              );
            })}
          </span>
        </div>
      </div>

      <div className="filters">
        <div className="searchbox">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#B84A7C"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar producto…"
          />
        </div>
        <div className="admin-filterbar">
          <div className="admin-filtergroup admin-filtergroup--brands">
            <span className="admin-filterlabel">Marca</span>
            <div className="admin-filteroptions">
              {visibleBrandChips.map((brand) => (
                <button
                  key={brand}
                  type="button"
                  className={brandFilter === brand ? "chip chip--active" : "chip"}
                  onClick={() => {
                    setBrandFilter(brand);
                    setBrandMenuOpen(false);
                  }}
                >
                  {brand}
                </button>
              ))}
              {overflowBrandChips.length > 0 ? (
                <div className="admin-filtermore-wrap">
                  <button
                    type="button"
                    className={
                      overflowBrandChips.includes(brandFilter)
                        ? "admin-filtermore admin-filtermore--selected"
                        : "admin-filtermore"
                    }
                    onClick={() => setBrandMenuOpen((open) => !open)}
                    aria-expanded={brandMenuOpen}
                  >
                    Ver más <span aria-hidden="true">⌄</span>
                  </button>
                  {brandMenuOpen ? (
                    <div className="admin-filtermore-menu">
                      {overflowBrandChips.map((brand) => (
                        <button
                          key={brand}
                          type="button"
                          className={
                            brandFilter === brand
                              ? "admin-filtermore-item admin-filtermore-item--active"
                              : "admin-filtermore-item"
                          }
                          onClick={() => {
                            setBrandFilter(brand);
                            setBrandMenuOpen(false);
                          }}
                        >
                          <span>{brand}</span>
                          {brandFilter === brand ? <span aria-hidden="true">✓</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {hasFilters ? (
            <>
              <span className="admin-filterdivider" aria-hidden="true" />
              <button type="button" className="admin-filterclear" onClick={clearFilters}>
                Quitar filtros
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="rows" ref={rowsRef}>
        {paginatedProducts.map((product) => {
          // La foto puede llegar colgada del producto o de cualquiera de sus
          // variantes. Un esmalte con 159 tonos tiene 159 imágenes y ningún
          // main_image_path: mirar solo ahí era ver el catálogo vacío.
          const cover = product.media_state?.portada_path ?? product.main_image_path;
          const photoCount = product.media_state?.fotos_total ?? 0;

          return (
            <div key={product.id} className="row">
              <div className="row-thumb">
                {cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={publicAssetUrl(cover)} alt={product.name} loading="lazy" />
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-label="Sin foto"
                    role="img"
                  >
                    <path d="M3 3l18 18" />
                    <path d="M21 15V6a2 2 0 0 0-2-2H8" />
                    <path d="M3 7v11a2 2 0 0 0 2 2h13" />
                    <circle cx="12" cy="12" r="2.4" />
                  </svg>
                )}
                {photoCount > 1 ? <span className="row-thumb-count">{formatCount(photoCount)}</span> : null}
              </div>
              <div className="row-id">
                <div className="row-brand">{(product.brand?.name ?? "—").toUpperCase()}</div>
                <div className="row-name">{product.name}</div>
                <div className="row-meta">
                  {[product.presentation, product.product_type].filter(Boolean).join(" · ") || product.code}
                  {" · "}
                  <span className={product.editorial_status === "published" ? "badge badge--carta" : "badge badge--sin-carta"}>
                    {EDITORIAL_BADGE[product.editorial_status] ?? product.editorial_status}
                  </span>
                </div>
              </div>
              <div className="row-prices">
                <div className="row-price-label">Unidad / Mayor</div>
                <div className="row-price">
                  {formatPrice(product.unit_price)} <em>/ {formatPrice(product.wholesale_price)}</em>
                </div>
              </div>
              <div className="row-carta">
                <span
                  className={
                    product.color_chart_status === "available"
                      ? "badge badge--carta"
                      : "badge badge--sin-carta"
                  }
                >
                  {product.color_chart_status === "available" ? "Con carta" : "Sin carta"}
                </span>
              </div>
              <button
                type="button"
                title="Cambiar estado"
                className={product.is_active ? "pub-btn pub-btn--on" : "pub-btn pub-btn--off"}
                onClick={() => togglePublished(product)}
                disabled={togglingId === product.id}
              >
                <span className="dot" />
                {product.is_active ? "Activo" : "Inactivo"}
              </button>
              <Link href={`/admin/productos/${product.id}`} className="btn-soft">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                Editar
              </Link>
            </div>
          );
        })}
      </div>

      <PremiumPagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={changePage}
      />

      {paginatedProducts.length === 0 ? (
        <div className="empty-card">
          <div className="empty-title">{hasFilters ? "Sin resultados" : "Aún no hay productos"}</div>
          <div className="empty-sub">
            {hasFilters
              ? "Prueba con otro término o quita los filtros."
              : "Crea el primer producto para armar tu catálogo."}
          </div>
        </div>
      ) : null}
    </div>
  );
}
