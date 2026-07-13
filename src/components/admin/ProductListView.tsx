"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi, formatPrice, publicAssetUrl } from "@/lib/admin/api";
import type { ApiProduct } from "@/lib/admin/types";

const STATE_CHIPS = ["Todos", "Publicado", "Oculto"] as const;

export function ProductListView() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [products, setProducts] = useState<ApiProduct[] | null>(null);
  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("Todas");
  const [stateFilter, setStateFilter] = useState<(typeof STATE_CHIPS)[number]>("Todos");
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    adminApi
      .listProducts()
      .then((items) => {
        if (!cancelled) {
          setProducts(items);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProducts([]);
          handleApiError(error, "No se pudieron cargar los productos.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [handleApiError]);

  const brandChips = useMemo(() => {
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
      if (brandFilter !== "Todas" && product.brand?.name !== brandFilter) {
        return false;
      }

      if (stateFilter !== "Todos") {
        const published = stateFilter === "Publicado";

        if (product.is_active !== published) {
          return false;
        }
      }

      if (!query) {
        return true;
      }

      const haystack =
        `${product.brand?.name ?? ""} ${product.name} ${product.code} ${product.product_type}`.toLowerCase();

      return haystack.includes(query);
    });
  }, [products, search, brandFilter, stateFilter]);

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
        nextActive ? `${product.name} publicado ✓` : `${product.name} oculto del catálogo`
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

  const publishedCount = products.filter((product) => product.is_active).length;

  return (
    <div className="br-fade">
      <div className="list-head">
        <div>
          <div className="page-title">Productos</div>
          <div className="page-sub">
            {products.length} en catálogo · {publishedCount} publicados
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
        <div className="chip-row">
          {brandChips.map((brand) => (
            <button
              key={brand}
              type="button"
              className={brandFilter === brand ? "chip chip--active" : "chip"}
              onClick={() => setBrandFilter(brand)}
            >
              {brand}
            </button>
          ))}
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

      <div className="rows">
        {filtered.map((product) => (
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
                {product.presentation} · {product.product_type}
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
              {product.is_active ? "Publicado" : "Oculto"}
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

      {filtered.length === 0 ? (
        <div className="empty-card">
          <div className="empty-title">
            {products.length === 0 ? "Aún no hay productos" : "Sin resultados"}
          </div>
          <div className="empty-sub">
            {products.length === 0
              ? "Crea el primer producto para armar tu catálogo."
              : "Prueba con otro término o limpia los filtros."}
          </div>
        </div>
      ) : null}
    </div>
  );
}
