"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BackIcon, BagIcon, WaIcon } from "@/components/public/icons";
import { useSelection } from "@/components/public/SelectionProvider";
import { publicAssetUrl } from "@/lib/admin/api";
import type { CartEvaluation } from "@/lib/catalog/contracts";
import { formatSoles, publicApi } from "@/lib/public/catalog";

export function SelectionView() {
  const router = useRouter();
  const { items, units, delivery, district, updateQty, removeItem, setDelivery, setDistrict, showToast, shareUrl } =
    useSelection();
  const [evaluation, setEvaluation] = useState<CartEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [sending, setSending] = useState<"order" | "advice" | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (items.length === 0) {
      setEvaluation(null);
      return;
    }

    setEvaluating(true);
    publicApi
      .evaluateCart(items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })))
      .then((data) => {
        if (!cancelled) setEvaluation(data);
      })
      .catch(() => {
        if (!cancelled) setEvaluation(null);
      })
      .finally(() => {
        if (!cancelled) setEvaluating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [items]);

  async function sendWhatsapp(intent: "order" | "advice") {
    if (items.length === 0 || sending) return;

    const popup = window.open("about:blank", "_blank");
    setSending(intent);

    try {
      const response = await publicApi.whatsapp({
        lines: items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
        intent,
        deliveryMethod: delivery === "envio" ? "shipping" : "pickup",
        customerNote: district ? `Distrito: ${district}` : undefined
      });

      if (popup) popup.location.href = response.url;
      else window.location.href = response.url;
    } catch {
      popup?.close();
      showToast("No se pudo generar el mensaje. Intenta nuevamente.");
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="pub-selpage br-fade">
      <div className="pub-fichabar">
        <button type="button" className="pub-backbtn" onClick={() => router.push("/")}>
          <BackIcon /> Seguir comprando
        </button>
        <div className="pub-selbar-title">Mi selección</div>
      </div>

      {items.length === 0 ? (
        <div className="pub-sel-empty">
          <div style={{ marginBottom: 10, color: "#D9A8C0" }}><BagIcon size={40} stroke="#D9A8C0" /></div>
          <div className="pub-sel-empty-title">Tu selección está esperando</div>
          <div className="pub-sel-empty-sub">Agrega una variante para iniciar tu consulta.</div>
          <button type="button" className="pub-cta-primary" onClick={() => router.push("/")}>
            Explorar catálogo
          </button>
        </div>
      ) : (
        <>
          <div className="pub-selrows">
            {items.map((item, index) => {
              const evaluated = evaluation?.lines.find((line) => line.variantId === item.variantId);
              const price = evaluated?.unitPrice ?? item.unitPrice;
              const mode = evaluated?.purchaseMode ?? item.purchaseMode;

              return (
                <div key={`${item.variantId}-${item.purchaseMode}`} className="pub-selrow">
                  <div className="pub-selrow-thumb" onClick={() => router.push(`/producto/${item.slug}?variante=${encodeURIComponent(item.sku)}`)}>
                    {item.imagePath ? <img src={publicAssetUrl(item.imagePath)} alt={item.variantName} /> : "Foto"}
                  </div>
                  <div className="pub-selrow-body">
                    <div className="pub-selrow-brand">SKU {item.sku}</div>
                    <div className="pub-selrow-name">{item.productName}</div>
                    <div className="pub-selrow-mode">
                      {item.variantName} · {mode === "wholesale" ? "Mayorista" : mode === "consult" ? "Consulta" : "Minorista"}
                    </div>
                    {evaluated?.wholesaleRule ? (
                      <div className="pub-selrow-mode">✓ {evaluated.wholesaleRule.name}</div>
                    ) : null}
                    <div className="pub-selrow-controls">
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button type="button" className="pub-qtybtn-dec pub-qtybtn-dec--sm" onClick={() => updateQty(index, -1)}>−</button>
                        <span className="pub-selrow-qty">{item.quantity}</span>
                        <button type="button" className="pub-qtybtn-inc pub-qtybtn-inc--sm" onClick={() => updateQty(index, 1)}>＋</button>
                      </div>
                      <div className="pub-selrow-priceinfo">
                        <div className="pub-selrow-unit">{formatSoles(price)}{price !== null ? " c/u" : ""}</div>
                        <div className="pub-selrow-sub">{formatSoles(evaluated?.subtotal ?? (price === null ? null : price * item.quantity))}</div>
                      </div>
                    </div>
                  </div>
                  <button type="button" className="pub-selrow-del" title="Eliminar" onClick={() => removeItem(index)}>✕</button>
                </div>
              );
            })}

            <div className="pub-delivery">
              <div className="pub-delivery-title">Entrega</div>
              <div className="pub-delivery-opts">
                <button type="button" className={delivery === "envio" ? "pub-delivery-opt pub-delivery-opt--active" : "pub-delivery-opt"} onClick={() => setDelivery("envio")}>
                  Envío<br /><span className="pub-delivery-optsub">Lima y provincias</span>
                </button>
                <button type="button" className={delivery === "recojo" ? "pub-delivery-opt pub-delivery-opt--active" : "pub-delivery-opt"} onClick={() => setDelivery("recojo")}>
                  Recojo<br /><span className="pub-delivery-optsub">Tienda física</span>
                </button>
              </div>
              {delivery === "envio" ? (
                <input className="pub-district" value={district} onChange={(event) => setDistrict(event.target.value)} placeholder="Distrito (opcional)" />
              ) : null}
            </div>

            <div className="pub-totals">
              <div className="pub-totals-row"><span>Total de unidades</span><b>{evaluation?.totalUnits ?? units}</b></div>
              <div className="pub-totals-main"><span>Subtotal referencial</span><span className="pub-totals-price">{formatSoles(evaluation?.subtotal ?? null)}</span></div>
              <div className="pub-totals-note">
                {evaluating ? "Recalculando precios y reglas…" : "La base valida disponibilidad y mayorista antes de generar WhatsApp."}
              </div>
            </div>
          </div>

          <div className="pub-sel-cta">
            <button type="button" className="pub-sendwa" disabled={evaluating || Boolean(sending)} onClick={() => sendWhatsapp("order")}>
              <WaIcon size={18} /> {sending === "order" ? "Generando…" : "Enviar pedido por WhatsApp"}
            </button>
            <button type="button" className="pub-sendwa-asesor" disabled={evaluating || Boolean(sending)} onClick={() => sendWhatsapp("advice")}>
              {sending === "advice" ? "Generando…" : "Primero quiero hablar con un asesor"}
            </button>
            {shareUrl ? (
              <button
                type="button"
                className="pub-sharelink"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(shareUrl);
                    showToast("Enlace copiado: ábrelo en otro dispositivo ✓");
                  } catch {
                    showToast(shareUrl);
                  }
                }}
              >
                Copiar enlace de mi selección
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
