"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BackIcon, ExpandIcon, WaIcon } from "@/components/public/icons";
import { useSelection } from "@/components/public/SelectionProvider";
import { useTaxonomy } from "@/components/public/PublicShell";
import { publicAssetUrl } from "@/lib/admin/api";
import type { ApiProduct } from "@/lib/admin/types";
import {
  appliedPrice,
  codesSummary,
  formatSoles,
  lampText,
  publicApi,
  waLink,
  type ToneMode
} from "@/lib/public/catalog";

const MODE_DEFS: { key: ToneMode; title: string; sub: string }[] = [
  { key: "surtidos", title: "Tonos surtidos", sub: "Tu asesor arma una variedad equilibrada" },
  { key: "set", title: "Set completo", sub: "Todos los tonos de la línea" },
  { key: "codigos", title: "Códigos específicos", sub: "Elige de la carta de colores" }
];

const THUMB_LABELS = ["01 · Principal", "02 · Detalle", "03 · Tonos", "04 · Galería"];

export function ProductView({ slug }: { slug: string }) {
  const router = useRouter();
  const { units, addItem, showToast } = useSelection();
  const { waNum } = useTaxonomy();
  const [product, setProduct] = useState<ApiProduct | null>(null);
  const [missing, setMissing] = useState(false);
  const [gix, setGix] = useState(0);
  const [qty, setQty] = useState(1);
  const [mode, setMode] = useState<ToneMode>("surtidos");
  const [codes, setCodes] = useState("");
  const [lbOpen, setLbOpen] = useState(false);
  const [lbIx, setLbIx] = useState(0);

  useEffect(() => {
    let cancelled = false;

    publicApi
      .getProduct(slug)
      .then((data) => {
        if (!cancelled) {
          setProduct(data);
          setMode(data.color_chart_status === "available" ? "surtidos" : "confirmar");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMissing(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  const slides = useMemo(() => {
    if (!product) {
      return [];
    }

    const gallery = [...product.gallery].sort((a, b) => a.sort_order - b.sort_order);

    return [
      { label: THUMB_LABELS[0], path: product.main_image_path },
      { label: THUMB_LABELS[1], path: gallery[0]?.path ?? null },
      { label: THUMB_LABELS[2], path: product.color_chart_image_path },
      { label: THUMB_LABELS[3], path: gallery[1]?.path ?? null }
    ];
  }, [product]);

  if (missing) {
    return (
      <div className="pub-noresults" style={{ marginTop: 40 }}>
        <div className="empty-title">Producto no encontrado</div>
        <div className="empty-sub">Puede que ya no esté publicado en el catálogo.</div>
        <button type="button" className="pub-clear" onClick={() => router.push("/")}>
          Volver al catálogo
        </button>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="loading-block">
        <span className="spinner spinner--pink" /> Cargando producto…
      </div>
    );
  }

  const carta = product.color_chart_status === "available";
  const soldOut = product.availability === "sold_out";
  const min = product.wholesale_min_quantity;
  const priceInfo = {
    unitPrice: product.unit_price,
    wholesalePrice: product.wholesale_price,
    wholesaleMin: min
  };
  const applied = appliedPrice(priceInfo, qty);
  const isMayor = qty >= min;
  const falta = min - qty;
  const ahorro = (product.unit_price - product.wholesale_price) * qty;
  const brandName = product.brand?.name ?? "";

  const waAsesorMsg = carta
    ? `Hola Bellaroshé, estoy revisando la carta de ${brandName} ${product.name}. Necesito ayuda para elegir ${qty} ${qty === 1 ? "tono." : "tonos."}`
    : `Hola Bellaroshé, estoy revisando ${brandName} ${product.name} ${product.presentation}. Necesito ${qty} ${qty === 1 ? "unidad" : "unidades"} y quisiera conocer los tonos disponibles.`;

  const cartaPdfUrl = product.color_chart_pdf_path
    ? publicAssetUrl(product.color_chart_pdf_path)
    : null;

  const summary = codesSummary(codes);
  let codesNote = "Escribe los códigos tal como aparecen en la carta.";
  let codesNoteFg = "var(--br-muted)";

  if (mode === "codigos" && codes.trim()) {
    if (summary.units === qty) {
      codesNote = `✓ ${summary.units} unidades en ${summary.count} códigos — coincide con tu cantidad.`;
      codesNoteFg = "var(--br-green)";
    } else {
      codesNote = `Tus códigos suman ${summary.units} und. y tu cantidad es ${qty}. Puedes continuar; tu asesor lo confirma.`;
      codesNoteFg = "#B07A2A";
    }
  }

  function handleAdd() {
    if (!product || soldOut) {
      return;
    }

    addItem({
      productId: product.id,
      slug: product.slug,
      brand: brandName,
      name: product.name,
      presentation: product.presentation,
      unitPrice: product.unit_price,
      wholesalePrice: product.wholesale_price,
      wholesaleMin: min,
      imagePath: product.main_image_path,
      qty,
      mode: carta ? mode : "confirmar",
      codes: carta && mode === "codigos" ? codes.trim() : ""
    });
    showToast("Agregado a tu selección ✓");
  }

  const currentSlide = slides[gix];
  const lbSlide = slides[lbIx] ?? slides[0];

  return (
    <div className="br-fade" style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <div className="pub-fichabar">
        <button type="button" className="pub-backbtn" onClick={() => router.push("/")}>
          <BackIcon />
          Catálogo
        </button>
        <button type="button" className="pub-selmini" onClick={() => router.push("/seleccion")}>
          Mi selección
          {units > 0 ? <span className="pub-count">{units}</span> : null}
        </button>
      </div>

      <div className="pub-ficha">
        <div>
          <div className="pub-gallery">
            <div className="pub-gallery-frame">
              {currentSlide?.path ? (
                  // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={publicAssetUrl(currentSlide.path)}
                  alt={`${product.name} — ${currentSlide.label}`}
                  style={{ cursor: "zoom-in" }}
                  onClick={() => {
                    setLbIx(gix);
                    setLbOpen(true);
                  }}
                />
              ) : (
                <span>{currentSlide?.label ?? "Foto"} — foto en camino</span>
              )}
            </div>
            <button
              type="button"
              className="pub-ampliar"
              onClick={() => {
                setLbIx(gix);
                setLbOpen(true);
              }}
            >
              <ExpandIcon />
              Ampliar
            </button>
          </div>
          <div className="pub-thumbs">
            {THUMB_LABELS.map((label, index) => (
              <button
                key={label}
                type="button"
                className={gix === index ? "pub-thumb pub-thumb--active" : "pub-thumb"}
                onClick={() => setGix(index)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="pub-ficha-info">
          <div className="pub-ficha-head">
            <div className="pub-ficha-brand">{brandName.toUpperCase()}</div>
            <div className="pub-ficha-title">{product.name}</div>
            <div className="pub-ficha-meta">
              {product.presentation} · {product.product_type} · {lampText(product)}
            </div>
            {product.description ? (
              <div className="pub-ficha-desc">{product.description}</div>
            ) : null}
          </div>

          <div className="pub-pricecards">
            <div className="pub-price-u">
              <div className="pub-price-label">Por unidad</div>
              <div className="pub-price-value">{formatSoles(product.unit_price)}</div>
            </div>
            <div className="pub-price-m">
              <div className="pub-ribbon">TE CONVIENE</div>
              <div className="pub-price-label">Por mayor · desde {min} und.</div>
              <div className="pub-price-value">{formatSoles(product.wholesale_price)}</div>
            </div>
          </div>
          <div className="pub-mayorhint">
            Desde {min} unidades aplica precio por mayor — puedes mezclar tonos.
          </div>

          <div className="pub-qtycard">
            <div className="pub-qtycard-label">Cantidad total</div>
            <div className="pub-qtyctrl">
              <button type="button" className="pub-qtybtn-dec" onClick={() => setQty((q) => Math.max(1, q - 1))}>
                −
              </button>
              <span className="pub-qty">{qty}</span>
              <button type="button" className="pub-qtybtn-inc" onClick={() => setQty((q) => q + 1)}>
                ＋
              </button>
            </div>
          </div>
          <div className={isMayor ? "pub-mayornote pub-mayornote--on" : "pub-mayornote pub-mayornote--off"}>
            {isMayor
              ? `Precio por mayor aplicado — estás ahorrando ${formatSoles(ahorro)}`
              : `Agrega ${falta} ${falta === 1 ? "unidad más" : "unidades más"} y desbloquea el precio por mayor`}
          </div>

          {carta ? (
            <div style={{ marginTop: 18 }}>
              <div className="pub-modes-title">¿Cómo eliges los tonos?</div>
              <div className="pub-modes">
                {MODE_DEFS.map((def) => (
                  <button
                    key={def.key}
                    type="button"
                    className={mode === def.key ? "pub-mode pub-mode--active" : "pub-mode"}
                    onClick={() => {
                      setMode(def.key);

                      if (def.key === "codigos") {
                        setGix(2);
                        setLbIx(2);
                        setLbOpen(true);
                      }
                    }}
                  >
                    <span className="pub-mode-dot" />
                    <span style={{ flex: 1 }}>
                      <span className="pub-mode-title">{def.title}</span>
                      <br />
                      <span className="pub-mode-sub">{def.sub}</span>
                    </span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                className="pub-vertonos"
                onClick={() => {
                  setGix(2);
                  setLbIx(2);
                  setLbOpen(true);
                }}
              >
                <ExpandIcon size={15} />
                Ver catálogo de tonos en pantalla completa
              </button>

              {cartaPdfUrl ? (
                <a
                  href={cartaPdfUrl}
                  target="_blank"
                  rel="noopener"
                  className="pub-vertonos"
                  style={{ marginTop: 8, textDecoration: "none" }}
                >
                  Ver carta completa en PDF ↗
                </a>
              ) : null}

              {mode === "codigos" ? (
                <div>
                  <input
                    className="pub-codes"
                    value={codes}
                    onChange={(event) => setCodes(event.target.value)}
                    placeholder="Ej. 042 x2, 061 x1, 085 x3"
                  />
                  <div className="pub-codes-note" style={{ color: codesNoteFg }}>
                    {codesNote}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="pub-sincarta">
              <div className="pub-sincarta-title">Amplia variedad de tonos</div>
              <div className="pub-sincarta-sub">
                Consulta los colores disponibles con un asesor.
                <br />
                Puedes agregarlo ahora con <b style={{ color: "#B84A7C" }}>tonos por confirmar</b>.
              </div>
            </div>
          )}

          <div className="pub-ficha-cta">
            <div className="pub-ficha-totalrow">
              <span>
                {qty} {qty === 1 ? "unidad" : "unidades"}
                {isMayor ? " · precio por mayor" : " · precio por unidad"}
              </span>
              <span className="pub-ficha-total">{formatSoles(applied * qty)}</span>
            </div>
            <div
              className="pub-stickynote"
              style={{ color: soldOut ? "#B03A3A" : isMayor ? "var(--br-green)" : "#B07A2A" }}
            >
              {soldOut
                ? "Producto agotado — consulta reposición con tu asesor"
                : isMayor
                  ? `Con precio por mayor estás ahorrando ${formatSoles(ahorro)} en este producto`
                  : `Lleva ${min} unidades y paga ${formatSoles(product.wholesale_price)} c/u — ahorrarías ${formatSoles((product.unit_price - product.wholesale_price) * min)}`}
            </div>
            <button type="button" className="pub-addbtn" onClick={handleAdd} disabled={soldOut}>
              {soldOut
                ? "Agotado por ahora"
                : carta
                  ? "Agregar a mi selección"
                  : "Agregar con tonos por confirmar"}
            </button>
            <a href={waLink(waNum, waAsesorMsg)} target="_blank" rel="noopener" className="pub-asesor">
              <WaIcon size={16} />
              Hablar con un asesor
            </a>
          </div>
        </div>
      </div>

      {lbOpen ? (
        <div className="pub-lb">
          <div className="pub-lb-head">
            <div className="pub-lb-title">
              {brandName} {product.name} · {THUMB_LABELS[lbIx]}
            </div>
            <button type="button" className="pub-lb-close" onClick={() => setLbOpen(false)}>
              ✕ Cerrar
            </button>
          </div>
          <div className="pub-lb-body">
            {lbSlide?.path ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={publicAssetUrl(lbSlide.path)} alt={`${product.name} — ${lbSlide.label}`} />
            ) : (
              <span>{lbSlide?.label} — imagen en camino</span>
            )}
          </div>
          <div className="pub-lb-foot">
            Imagen a tamaño completo — ideal para revisar los códigos de cada tono.
          </div>
        </div>
      ) : null}
    </div>
  );
}
