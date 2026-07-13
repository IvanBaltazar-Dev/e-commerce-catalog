"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ImageSlot } from "@/components/admin/ImageSlot";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { AdminApiError, adminApi } from "@/lib/admin/api";
import type { ApiProduct, ApiTaxonomy, LampType, ProductPayload } from "@/lib/admin/types";

const TIPOS = ["Esmalte tradicional", "Efecto gel sin lámpara", "Gel semipermanente"] as const;
const LAMPS: LampType[] = ["No", "Sí", "UV/LED"];

type FormState = {
  codigo: string;
  marca: string;
  nombre: string;
  pres: string;
  tipo: string;
  lamp: LampType;
  disp: boolean;
  u: string;
  m: string;
  min: string;
  desc: string;
  carta: boolean;
  pub: boolean;
  imgMain: string | null;
  imgDetail: string | null;
  imgTones: string | null;
  imgSet: string | null;
};

function emptyForm(): FormState {
  return {
    codigo: "",
    marca: "",
    nombre: "",
    pres: "",
    tipo: "Gel semipermanente",
    lamp: "Sí",
    disp: true,
    u: "",
    m: "",
    min: "3",
    desc: "",
    carta: false,
    pub: false,
    imgMain: null,
    imgDetail: null,
    imgTones: null,
    imgSet: null
  };
}

function priceInput(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function productToForm(product: ApiProduct): FormState {
  const gallery = [...product.gallery].sort((a, b) => a.sort_order - b.sort_order);

  return {
    codigo: product.code,
    marca: product.brand?.name ?? "",
    nombre: product.name,
    pres: product.presentation,
    tipo: product.product_type,
    lamp: product.lamp_type ?? (product.requires_lamp ? "Sí" : "No"),
    disp: product.availability !== "sold_out",
    u: priceInput(product.unit_price),
    m: priceInput(product.wholesale_price),
    min: String(product.wholesale_min_quantity),
    desc: product.description ?? "",
    carta: product.color_chart_status === "available",
    pub: product.is_active,
    imgMain: product.main_image_path,
    imgTones: product.color_chart_image_path,
    imgDetail: gallery[0]?.path ?? null,
    imgSet: gallery[1]?.path ?? null
  };
}

function parseDecimal(value: string) {
  const parsed = Number(value.replace(",", ".").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function autoCode(marca: string, nombre: string, pres: string) {
  const clean = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .toUpperCase();
  const digits = pres.replace(/\D/g, "");
  const parts = [clean(marca).slice(0, 3), clean(nombre).slice(0, 4), digits].filter(Boolean);

  return parts.length > 0 ? parts.join("-") : `PROD-${Date.now().toString(36).toUpperCase()}`;
}

function isDuplicateError(error: unknown) {
  return (
    error instanceof AdminApiError && /duplicate key|already exists|unique/i.test(error.message)
  );
}

async function ensureTaxonomyId(
  list: ApiTaxonomy[],
  name: string,
  create: (name: string) => Promise<ApiTaxonomy>,
  refresh: () => Promise<ApiTaxonomy[]>
) {
  const needle = name.trim().toLowerCase();
  const found = list.find((item) => item.name.trim().toLowerCase() === needle);

  if (found) {
    return found.id;
  }

  try {
    const createdItem = await create(name.trim());
    return createdItem.id;
  } catch (error) {
    // Puede existir con otro nombre visible u oculto: reintenta tras refrescar.
    const latest = await refresh();
    const again = latest.find((item) => item.name.trim().toLowerCase() === needle);

    if (again) {
      return again.id;
    }

    throw error;
  }
}

export function ProductForm({ productId }: { productId?: string }) {
  const router = useRouter();
  const showToast = useToast();
  const handleApiError = useApiError();
  const [form, setForm] = useState<FormState | null>(productId ? null : emptyForm());
  const [brands, setBrands] = useState<ApiTaxonomy[]>([]);
  const [categories, setCategories] = useState<ApiTaxonomy[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [brandItems, categoryItems, product] = await Promise.all([
          adminApi.listBrands(),
          adminApi.listCategories(),
          productId ? adminApi.getProduct(productId) : Promise.resolve(null)
        ]);

        if (cancelled) {
          return;
        }

        setBrands(brandItems);
        setCategories(categoryItems);

        if (product) {
          setForm(productToForm(product));
        }
      } catch (error) {
        if (!cancelled) {
          handleApiError(error, "No se pudo cargar el producto.");
          router.replace("/admin/productos");
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [productId, handleApiError, router]);

  function patch(partial: Partial<FormState>) {
    setForm((current) => (current ? { ...current, ...partial } : current));
  }

  async function handleSave() {
    if (!form || saving) {
      return;
    }

    if (!form.marca.trim() || !form.nombre.trim() || !form.pres.trim() || !form.u.trim()) {
      showToast("Completa marca, nombre, presentación y precio unidad");
      return;
    }

    const unitPrice = parseDecimal(form.u);

    if (unitPrice === null) {
      showToast("El precio por unidad no es válido");
      return;
    }

    const wholesalePrice = form.m.trim() ? parseDecimal(form.m) : unitPrice;

    if (wholesalePrice === null) {
      showToast("El precio por mayor no es válido");
      return;
    }

    const minQty = form.min.trim() ? Number.parseInt(form.min, 10) : 3;

    if (!Number.isInteger(minQty) || minQty < 1) {
      showToast("El mínimo mayorista no es válido");
      return;
    }

    setSaving(true);

    try {
      const [brandId, categoryId] = await Promise.all([
        ensureTaxonomyId(brands, form.marca, adminApi.createBrand, adminApi.listBrands),
        ensureTaxonomyId(categories, form.tipo, adminApi.createCategory, adminApi.listCategories)
      ]);

      const payload: ProductPayload = {
        code: form.codigo.trim() || autoCode(form.marca, form.nombre, form.pres),
        brandId,
        categoryId,
        name: form.nombre.trim(),
        presentation: form.pres.trim(),
        productType: form.tipo,
        requiresLamp: form.lamp !== "No",
        lampType: form.lamp,
        description: form.desc.trim() ? form.desc.trim() : null,
        unitPrice,
        wholesalePrice,
        wholesaleMinQuantity: minQty,
        availability: form.disp ? "available" : "sold_out",
        colorChartStatus: form.carta ? "available" : "consult_advisor",
        mainImagePath: form.imgMain,
        colorChartImagePath: form.imgTones,
        isActive: form.pub,
        gallery: [
          ...(form.imgDetail ? [{ path: form.imgDetail, sortOrder: 1 }] : []),
          ...(form.imgSet ? [{ path: form.imgSet, sortOrder: 2 }] : [])
        ]
      };

      if (productId) {
        await adminApi.updateProduct(productId, payload);
      } else {
        try {
          await adminApi.createProduct(payload);
        } catch (error) {
          if (isDuplicateError(error) && !form.codigo.trim()) {
            await adminApi.createProduct({
              ...payload,
              code: `${payload.code}-${Math.floor(10 + Math.random() * 90)}`
            });
          } else {
            throw error;
          }
        }
      }

      showToast(
        form.pub ? "Producto guardado y publicado ✓" : "Producto guardado como oculto ✓"
      );
      router.push("/admin/productos");
    } catch (error) {
      if (isDuplicateError(error)) {
        showToast("Ya existe un producto con ese código.");
      } else {
        handleApiError(error, "No se pudo guardar el producto.");
      }

      setSaving(false);
    }
  }

  if (!form) {
    return (
      <div className="loading-block">
        <span className="spinner spinner--pink" /> Cargando producto…
      </div>
    );
  }

  return (
    <div className="form-page br-fade">
      <button type="button" className="back-btn" onClick={() => router.push("/admin/productos")}>
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Volver a productos
      </button>

      <div className="form-head">
        <div className="form-title">{productId ? "Editar producto" : "Nuevo producto"}</div>
        <button
          type="button"
          className={form.pub ? "toggle-pill toggle-pill--on" : "toggle-pill toggle-pill--off"}
          onClick={() => patch({ pub: !form.pub })}
        >
          <span className="dot" />
          {form.pub ? "Publicado en el catálogo" : "Oculto del catálogo"}
        </button>
      </div>

      <div className="form-card">
        <div className="grid-fields">
          <div>
            <div className="field-label">Código</div>
            <input
              className="input"
              value={form.codigo}
              onChange={(event) => patch({ codigo: event.target.value })}
              placeholder="ej. MAS-TRAD-135"
            />
          </div>
          <div>
            <div className="field-label">Marca</div>
            <input
              className="input"
              value={form.marca}
              onChange={(event) => patch({ marca: event.target.value })}
              placeholder="ej. Masglo"
              list="brand-options"
            />
            <datalist id="brand-options">
              {brands.map((brand) => (
                <option key={brand.id} value={brand.name} />
              ))}
            </datalist>
          </div>
          <div>
            <div className="field-label">Nombre / línea</div>
            <input
              className="input"
              value={form.nombre}
              onChange={(event) => patch({ nombre: event.target.value })}
              placeholder="ej. Gel Evolution"
            />
          </div>
          <div>
            <div className="field-label">Presentación</div>
            <input
              className="input"
              value={form.pres}
              onChange={(event) => patch({ pres: event.target.value })}
              placeholder="ej. 13.5 ml"
            />
          </div>
        </div>

        <div className="form-section">
          <div className="field-label" style={{ marginBottom: 7 }}>
            Tipo de esmalte
          </div>
          <div className="chip-row">
            {TIPOS.map((tipo) => (
              <button
                key={tipo}
                type="button"
                className={form.tipo === tipo ? "opt-chip opt-chip--active" : "opt-chip"}
                onClick={() => patch({ tipo })}
              >
                {tipo}
              </button>
            ))}
          </div>
        </div>

        <div className="grid-fields form-section">
          <div>
            <div className="field-label" style={{ marginBottom: 7 }}>
              ¿Requiere lámpara?
            </div>
            <div className="opt-tiles">
              {LAMPS.map((lamp) => (
                <button
                  key={lamp}
                  type="button"
                  className={form.lamp === lamp ? "opt-tile opt-tile--active" : "opt-tile"}
                  onClick={() => patch({ lamp })}
                >
                  {lamp}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="field-label" style={{ marginBottom: 7 }}>
              Disponibilidad
            </div>
            <div className="opt-tiles">
              <button
                type="button"
                className={form.disp ? "opt-tile opt-tile--active" : "opt-tile"}
                onClick={() => patch({ disp: true })}
              >
                Disponible
              </button>
              <button
                type="button"
                className={!form.disp ? "opt-tile opt-tile--active" : "opt-tile"}
                onClick={() => patch({ disp: false })}
              >
                Agotado
              </button>
            </div>
          </div>
        </div>

        <div className="grid-prices">
          <div>
            <div className="field-label">Precio unidad (S/)</div>
            <input
              className="input"
              value={form.u}
              onChange={(event) => patch({ u: event.target.value })}
              placeholder="11"
              inputMode="decimal"
            />
          </div>
          <div>
            <div className="field-label">Precio mayor (S/)</div>
            <input
              className="input input--wholesale"
              value={form.m}
              onChange={(event) => patch({ m: event.target.value })}
              placeholder="9.50"
              inputMode="decimal"
            />
          </div>
          <div>
            <div className="field-label">Mínimo mayorista</div>
            <input
              className="input"
              value={form.min}
              onChange={(event) => patch({ min: event.target.value })}
              placeholder="3"
              inputMode="numeric"
            />
          </div>
        </div>

        <div className="form-section">
          <div className="field-label">Descripción comercial</div>
          <textarea
            className="input textarea"
            value={form.desc}
            onChange={(event) => patch({ desc: event.target.value })}
            placeholder="Frase breve y vendedora para la ficha del producto…"
          />
        </div>

        <div className="form-section">
          <div className="field-label" style={{ marginBottom: 7 }}>
            Imágenes del producto
          </div>
          <div className="img-grid">
            <ImageSlot
              label="01 · Principal"
              path={form.imgMain}
              kind="product-image"
              onChange={(path) => patch({ imgMain: path })}
            />
            <ImageSlot
              label="02 · Detalle"
              path={form.imgDetail}
              kind="product-image"
              onChange={(path) => patch({ imgDetail: path })}
            />
            <ImageSlot
              label="03 · Tonos"
              path={form.imgTones}
              kind="color-chart"
              onChange={(path) => patch({ imgTones: path })}
            />
            <ImageSlot
              label="04 · Set"
              path={form.imgSet}
              kind="product-image"
              onChange={(path) => patch({ imgSet: path })}
            />
          </div>
        </div>

        <div className="form-section">
          <div className="carta-head">
            <div>
              <div className="field-label" style={{ marginBottom: 3 }}>
                Carta de colores
              </div>
              <div className="field-hint">
                Si no cargas carta, el catálogo mostrará «Consultar tonos con un asesor».
              </div>
            </div>
            <button
              type="button"
              className={form.carta ? "carta-toggle carta-toggle--on" : "carta-toggle"}
              onClick={() => patch({ carta: !form.carta })}
            >
              {form.carta ? "Con carta de colores" : "Sin carta — asesor"}
            </button>
          </div>
          {form.carta ? (
            <div className="carta-note">
              La imagen «03 · Tonos» funciona como catálogo de colores: en la ficha pública se
              amplía a pantalla completa para revisar los códigos.
            </div>
          ) : null}
        </div>
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn-cancel"
          onClick={() => router.push("/admin/productos")}
        >
          Cancelar
        </button>
        <button type="button" className="btn-save" onClick={handleSave} disabled={saving}>
          {saving ? <span className="spinner" /> : null}
          {saving ? "Guardando…" : "Guardar producto"}
        </button>
      </div>
    </div>
  );
}
