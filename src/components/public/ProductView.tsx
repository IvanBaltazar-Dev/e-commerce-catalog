"use client";
/* eslint-disable @next/next/no-img-element */

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BackIcon, ExpandIcon, WaIcon } from "@/components/public/icons";
import { useSelection } from "@/components/public/SelectionProvider";
import { publicAssetUrl } from "@/lib/admin/api";
import type { CatalogMedia, CatalogProductDetail, PurchasableVariant } from "@/lib/catalog/contracts";
import { formatSoles, publicApi, retailPrice, variantImage } from "@/lib/public/catalog";

// Tintes por familia cromática: el respaldo visual cuando un tono aún no tiene
// fotografía. Nunca sustituyen una foto real; solo evitan un círculo mudo.
const FAMILY_TINTS: Record<string, string> = {
  rojos: "#C0392B",
  rosados: "#E38AA8",
  morados: "#7D4B9E",
  azules: "#3B6FB5",
  verdes: "#5B8C5A",
  "amarillos-dorados": "#D9A62E",
  "naranjas-corales": "#E07B4F",
  nude: "#D9B49B",
  marrones: "#8A5A3B",
  blancos: "#F2EEE9",
  "negros-grises": "#4A4A4A",
  metalicos: "#9FA8B5",
  multicolor: "#C96A82",
  "por-clasificar": "#CFC4BC"
};

function SwatchCircle({ item, active, size = 52 }: { item: PurchasableVariant; active: boolean; size?: number }) {
  const photo = item.media.find((media) => media.role === "swatch" || media.role === "main")?.path ?? null;
  const family = item.attributes.find((attribute) => attribute.code === "color_family")?.optionValue ?? null;
  const tint = family ? FAMILY_TINTS[family] ?? "#CFC4BC" : "#E8E0DA";
  const ring = active ? "0 0 0 3px var(--br-magenta, #A80D5C)" : "inset 0 0 0 1px rgba(0,0,0,0.12)";
  if (photo) {
    return (
      <img
        src={publicAssetUrl(photo)}
        alt={item.name}
        loading="lazy"
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", boxShadow: ring, flexShrink: 0 }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: "50%", background: tint, boxShadow: ring, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.32, color: "rgba(255,255,255,0.9)", fontWeight: 700 }}
    >
      {item.name.charAt(0).toUpperCase()}
    </span>
  );
}

function mediaFor(product: CatalogProductDetail, variant: PurchasableVariant) {
  const seen = new Set<string>();
  return [...variant.media, ...product.media].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function attributeText(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (value === null || value === undefined) return "—";
  return String(value);
}

export function ProductView({ slug }: { slug: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { units, addItem, showToast } = useSelection();
  const [product, setProduct] = useState<CatalogProductDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [variantId, setVariantId] = useState("");
  const [qty, setQty] = useState(1);
  const [mediaIndex, setMediaIndex] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMissing(false);
    publicApi.getProduct(slug).then((data) => {
      if (cancelled) return;
      setProduct(data);
      const requested = searchParams.get("variante");
      const selected = data.variants.find((item) => item.id === requested || item.sku === requested)
        ?? data.variants.find((item) => item.isDefault)
        ?? data.variants[0];
      setVariantId(selected?.id ?? "");
    }).catch(() => {
      if (!cancelled) setMissing(true);
    });
    return () => { cancelled = true; };
  }, [slug, searchParams]);

  const variant = useMemo(
    () => product?.variants.find((item) => item.id === variantId) ?? product?.variants[0] ?? null,
    [product, variantId]
  );
  const media = useMemo(() => product && variant ? mediaFor(product, variant) : [], [product, variant]);
  const currentMedia = media[mediaIndex] ?? null;

  useEffect(() => setMediaIndex(0), [variantId]);

  if (missing) {
    return <div className="pub-noresults" style={{ marginTop: 40 }}><div className="empty-title">Producto no encontrado</div><div className="empty-sub">Puede que ya no esté publicado en el catálogo.</div><button type="button" className="pub-clear" onClick={() => router.push("/")}>Volver al catálogo</button></div>;
  }

  if (!product || !variant) return <div className="loading-block"><span className="spinner spinner--pink" /> Cargando producto…</div>;

  const currentProduct = product;
  const currentVariant = variant;
  const retail = retailPrice(currentVariant);
  const wholesalePrices = variant.prices.filter((price) => price.type === "wholesale").sort((a, b) => a.minimumQuantity - b.minimumQuantity);
  const wholesale = [...wholesalePrices].reverse().find((price) => qty >= price.minimumQuantity) ?? null;
  const applicablePrice = wholesale?.amount ?? retail;
  const consult = variant.availability === "consult" || applicablePrice === null;
  const soldOut = variant.availability === "sold_out";
  const productAttributes = [...product.attributes, ...variant.attributes];
  const primaryPath = variantImage(variant) ?? product.media.find((item) => item.isPrimary)?.path ?? product.media[0]?.path ?? null;

  function selectVariant(next: PurchasableVariant) {
    setVariantId(next.id);
    setQty(1);
    const params = new URLSearchParams(searchParams.toString());
    params.set("variante", next.sku);
    router.replace(`/producto/${currentProduct.slug}?${params.toString()}`, { scroll: false });
  }

  function addCurrent() {
    if (soldOut) return;
    addItem({
      productId: currentProduct.productId,
      variantId: currentVariant.id,
      sku: currentVariant.sku,
      productName: currentProduct.name,
      variantName: currentVariant.name,
      slug: currentProduct.slug,
      imagePath: primaryPath,
      quantity: qty,
      unitPrice: applicablePrice,
      purchaseMode: consult ? "consult" : wholesale ? "wholesale" : "retail",
      availability: currentVariant.availability
    });
    showToast(consult ? "Agregado para cotización ✓" : "Agregado a tu selección ✓");
  }

  async function askAdvisor() {
    if (sending) return;
    const popup = window.open("about:blank", "_blank");
    setSending(true);
    try {
      const response = await publicApi.whatsapp({ lines: [{ variantId: currentVariant.id, quantity: qty }], intent: "advice" });
      if (popup) popup.location.href = response.url;
      else window.location.href = response.url;
    } catch {
      popup?.close();
      showToast("No se pudo generar el mensaje. Intenta nuevamente.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="br-fade" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <div className="pub-fichabar">
        <button type="button" className="pub-backbtn" onClick={() => router.push("/")}><BackIcon /> Catálogo</button>
        <button type="button" className="pub-selmini" onClick={() => router.push("/seleccion")}>Mi selección{units > 0 ? <span className="pub-count">{units}</span> : null}</button>
      </div>

      <div className="pub-ficha">
        <div>
          <div className="pub-gallery">
            <div className="pub-gallery-frame">
              {(currentMedia?.path ?? primaryPath) ? (
                <img src={publicAssetUrl(currentMedia?.path ?? primaryPath!)} alt={currentMedia?.altText ?? `${product.name} — ${variant.name}`} onClick={() => setLightbox(true)} style={{ cursor: "zoom-in" }} />
              ) : <span>Foto en camino</span>}
            </div>
            <button type="button" className="pub-ampliar" onClick={() => setLightbox(true)}><ExpandIcon /> Ampliar</button>
          </div>
          {media.length > 0 ? <div className="pub-thumbs">{media.slice(0, 5).map((item: CatalogMedia, index) => <button key={item.id} type="button" className={mediaIndex === index ? "pub-thumb pub-thumb--active" : "pub-thumb"} onClick={() => setMediaIndex(index)}>{item.role === "color_chart" ? "Carta" : `${index + 1}`}</button>)}</div> : null}
        </div>

        <div className="pub-ficha-info">
          <div className="pub-ficha-head">
            <div className="pub-ficha-brand">{product.brand.name.toUpperCase()} · {product.category.name}</div>
            <div className="pub-ficha-title">{product.name}</div>
            <div className="pub-ficha-meta">SKU {variant.sku} · {variant.name}</div>
            {product.shortDescription ? <div className="pub-ficha-desc">{product.shortDescription}</div> : null}
            {product.description ? <div className="pub-ficha-desc">{product.description}</div> : null}
          </div>

          {product.variants.length > 1 ? (
            <div style={{ marginTop: 18 }}>
              <div className="pub-modes-title">
                Elige una variante · {product.variants.length} disponibles
              </div>
              {product.variants.length > 12 ? (
                // Con decenas de tonos, la lista vertical no se puede recorrer:
                // rejilla de swatches (foto real; si no hay, tinte de su familia
                // cromática) con el tono elegido siempre visible arriba.
                <>
                  <div className="pub-ficha-meta" style={{ margin: "6px 0 10px" }}>
                    Elegido: <b>{variant.name}</b> · SKU {variant.sku}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 10, maxHeight: 380, overflowY: "auto", paddingRight: 4 }}>
                    {product.variants.map((item) => {
                      const active = item.id === variant.id;
                      const soldOutItem = item.availability === "sold_out";
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => selectVariant(item)}
                          title={`${item.name} · SKU ${item.sku}`}
                          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", padding: 4, opacity: soldOutItem ? 0.45 : 1 }}
                        >
                          <SwatchCircle item={item} active={active} />
                          <span style={{ fontSize: 11, lineHeight: 1.2, textAlign: "center", color: active ? "var(--br-magenta, #A80D5C)" : "#5B5B5B", fontWeight: active ? 700 : 500, maxWidth: 76, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {item.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="pub-modes">
                  {product.variants.map((item) => (
                    <button key={item.id} type="button" className={item.id === variant.id ? "pub-mode pub-mode--active" : "pub-mode"} onClick={() => selectVariant(item)}>
                      <SwatchCircle item={item} active={item.id === variant.id} size={34} />
                      <span style={{ flex: 1, marginLeft: 10 }}><span className="pub-mode-title">{item.name}</span><br /><span className="pub-mode-sub">SKU {item.sku} · {item.availability === "available" ? formatSoles(retailPrice(item)) : item.availability === "consult" ? "Consultar" : "Agotado"}</span></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          <div className="pub-pricecards">
            <div className="pub-price-u"><div className="pub-price-label">Precio minorista</div><div className="pub-price-value">{formatSoles(retail)}</div></div>
            <div className="pub-price-m"><div className="pub-price-label">{wholesale ? `Mayorista aplicado · ${wholesale.minimumQuantity}+` : "Precio por mayor"}</div><div className="pub-price-value">{wholesale ? formatSoles(wholesale.amount) : wholesalePrices[0] ? `${formatSoles(wholesalePrices[0].amount)} · ${wholesalePrices[0].minimumQuantity}+` : "Consultar"}</div></div>
          </div>

          <div className="pub-qtycard"><div className="pub-qtycard-label">Cantidad</div><div className="pub-qtyctrl"><button type="button" className="pub-qtybtn-dec" onClick={() => setQty((value) => Math.max(1, value - 1))}>−</button><span className="pub-qty">{qty}</span><button type="button" className="pub-qtybtn-inc" onClick={() => setQty((value) => value + 1)}>＋</button></div></div>
          <div className={wholesale ? "pub-mayornote pub-mayornote--on" : "pub-mayornote pub-mayornote--off"}>{soldOut ? "Variante agotada" : consult ? "Un asesor confirmará precio y disponibilidad" : wholesale ? "Precio mayorista aplicado por la base de datos" : wholesalePrices[0] ? `Desde ${wholesalePrices[0].minimumQuantity} unidades aplica el precio por mayor` : "Precio minorista vigente"}</div>

          {productAttributes.length > 0 ? <div className="pub-sincarta" style={{ textAlign: "left" }}><div className="pub-sincarta-title">Especificaciones</div>{productAttributes.map((attribute) => <div key={`${attribute.code}-${attribute.optionValue ?? "value"}`} className="pub-ficha-meta" style={{ marginTop: 6 }}><b>{attribute.name}:</b> {attributeText(attribute.value)}{attribute.unit ? ` ${attribute.unit}` : ""}</div>)}</div> : null}

          <div className="pub-ficha-cta">
            <div className="pub-ficha-totalrow"><span>{qty} {qty === 1 ? "unidad" : "unidades"} · {variant.name}</span><span className="pub-ficha-total">{applicablePrice === null ? "Por cotizar" : formatSoles(applicablePrice * qty)}</span></div>
            <div className="pub-stickynote" style={{ color: soldOut ? "#B03A3A" : consult ? "#B07A2A" : "var(--br-green)" }}>{soldOut ? "No se puede agregar mientras esté agotada" : consult ? "La selección se enviará como consulta, sin precio inventado" : "Precio sujeto a validación final de stock"}</div>
            <button type="button" className="pub-addbtn" onClick={addCurrent} disabled={soldOut}>{soldOut ? "Agotado por ahora" : consult ? "Agregar para cotizar" : "Agregar a mi selección"}</button>
            <button type="button" className="pub-asesor" onClick={askAdvisor} disabled={sending}><WaIcon size={16} />{sending ? "Generando mensaje…" : "Hablar con un asesor"}</button>
          </div>
        </div>
      </div>

      {lightbox ? <div className="pub-lb"><div className="pub-lb-head"><div className="pub-lb-title">{product.name} · {variant.name}</div><button type="button" className="pub-lb-close" onClick={() => setLightbox(false)}>✕ Cerrar</button></div><div className="pub-lb-body">{(currentMedia?.path ?? primaryPath) ? <img src={publicAssetUrl(currentMedia?.path ?? primaryPath!)} alt={currentMedia?.altText ?? product.name} /> : <span>Imagen en camino</span>}</div></div> : null}
    </div>
  );
}
