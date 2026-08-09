"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { PremiumPagination } from "@/components/PremiumPagination";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, formatPrice, publicAssetUrl } from "@/lib/admin/api";
import type { ApiProduct } from "@/lib/admin/types";

const STATE_CHIPS = ["Todos", "Publicados", "Borradores", "Ocultos"] as const;
const ESTADO_PARAM: Record<(typeof STATE_CHIPS)[number], "publicado" | "borrador" | "oculto" | undefined> = {
  Todos: undefined,
  Publicados: "publicado",
  Borradores: "borrador",
  Ocultos: "oculto"
};
const EDITORIAL_BADGE: Record<string, string> = {
  published: "Publicado",
  draft: "Borrador",
  in_review: "En revisión",
  incomplete: "Incompleto",
  hidden: "Oculto"
};
const ADMIN_PAGE_SIZE = 8;
const VISIBLE_BRAND_FILTERS = 4;

export function ProductListView() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [products, setProducts] = useState<ApiProduct[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);
  const [brandFilter, setBrandFilter] = useState("Todas");
  const [stateFilter, setStateFilter] = useState<(typeof STATE_CHIPS)[number]>("Todos");
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
  }, [debouncedSearch, brandFilter, stateFilter]);

  useEffect(() => {
    let cancelled = false;
    const brandId = brands.find((brand) => brand.name === brandFilter)?.id;

    adminApi
      .listProductsPage({
        page,
        pageSize: ADMIN_PAGE_SIZE,
        q: debouncedSearch || undefined,
        estado: ESTADO_PARAM[stateFilter],
        brandId
      })
      .then((result) => {
        if (!cancelled) {
          setProducts(result.items);
          setTotal(result.total);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProducts([]);
          setTotal(0);
          handleApiError(error, "No se pudieron cargar los productos.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [page, debouncedSearch, brandFilter, stateFilter, brands, handleApiError]);

  const brandChips = useMemo(() => ["Todas", ...brands.map((brand) => brand.name)], [brands]);

  const visibleBrandChips = brandChips.slice(0, VISIBLE_BRAND_FILTERS);
  const overflowBrandChips = brandChips.slice(VISIBLE_BRAND_FILTERS);
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedProducts = products ?? [];

  function changePage(nextPage: number) {
    setPage(nextPage);
    requestAnimationFrame(() => {
      rowsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
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
            {total.toLocaleString("es-PE")} en catálogo · página {currentPage} de {totalPages}
          </div>
        </div>
        <Link href="/admin/productos/nuevo" className="btn-primary">
          <span className="btn-new-icon">＋</span> Nuevo producto
        </Link>
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

          <span className="admin-filterdivider" aria-hidden="true" />

          <div className="admin-filtergroup admin-filtergroup--status">
            <span className="admin-filterlabel">Publicación</span>
            <div className="admin-filteroptions">
              {STATE_CHIPS.map((state) => (
                <button
                  key={state}
                  type="button"
                  className={stateFilter === state ? "chip chip--active" : "chip"}
                  onClick={() => setStateFilter(state)}
                >
                  {state}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="rows" ref={rowsRef}>
        {paginatedProducts.map((product) => (
          <div key={product.id} className="row">
            <div className="row-thumb">
              {product.main_image_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={publicAssetUrl(product.main_image_path)} alt={product.name} />
              ) : (
                "Foto"
              )}
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
        ))}
      </div>

      <PremiumPagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={changePage}
      />

      {paginatedProducts.length === 0 ? (
        <div className="empty-card">
          <div className="empty-title">
            {total === 0 && !debouncedSearch && stateFilter === "Todos" && brandFilter === "Todas"
              ? "Aún no hay productos"
              : "Sin resultados"}
          </div>
          <div className="empty-sub">
            {total === 0 && !debouncedSearch && stateFilter === "Todos" && brandFilter === "Todas"
              ? "Crea el primer producto para armar tu catálogo."
              : "Prueba con otro término o limpia los filtros."}
          </div>
        </div>
      ) : null}
    </div>
  );
}
