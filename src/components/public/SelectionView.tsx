"use client";

import { useRouter } from "next/navigation";
import { BackIcon, BagIcon, WaIcon } from "@/components/public/icons";
import { useSelection } from "@/components/public/SelectionProvider";
import { useTaxonomy } from "@/components/public/PublicShell";
import { publicAssetUrl } from "@/lib/admin/api";
import {
  MODE_LABEL,
  appliedPrice,
  formatSoles,
  orderMessage,
  waLink
} from "@/lib/public/catalog";

export function SelectionView() {
  const router = useRouter();
  const { items, units, delivery, district, updateQty, removeItem, setDelivery, setDistrict } =
    useSelection();
  const { waNum } = useTaxonomy();

  const total = items.reduce((acc, item) => acc + item.qty * appliedPrice(item, item.qty), 0);

  return (
    <div className="pub-selpage br-fade">
      <div className="pub-fichabar">
        <button type="button" className="pub-backbtn" onClick={() => router.push("/")}>
          <BackIcon />
          Seguir comprando
        </button>
        <div className="pub-selbar-title">Mi selección</div>
      </div>

      {items.length === 0 ? (
        <div className="pub-sel-empty">
          <div style={{ marginBottom: 10, color: "#D9A8C0" }}>
            <BagIcon size={40} stroke="#D9A8C0" />
          </div>
          <div className="pub-sel-empty-title">Tu selección está esperando</div>
          <div className="pub-sel-empty-sub">
            Agrega tus esmaltes favoritos — se guardan mientras navegas.
          </div>
          <button type="button" className="pub-cta-primary" onClick={() => router.push("/")}>
            Explorar catálogo
          </button>
        </div>
      ) : (
        <>
          <div className="pub-selrows">
            {items.map((item, index) => {
              const price = appliedPrice(item, item.qty);
              const pending = item.mode === "confirmar";

              return (
                <div key={`${item.productId}-${item.mode}-${index}`} className="pub-selrow">
                  <div
                    className="pub-selrow-thumb"
                    onClick={() => router.push(`/producto/${item.slug}`)}
                  >
                    {item.imagePath ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={publicAssetUrl(item.imagePath)} alt={item.name} />
                    ) : (
                      "Foto"
                    )}
                  </div>
                  <div className="pub-selrow-body">
                    <div className="pub-selrow-brand">{item.brand.toUpperCase()}</div>
                    <div className="pub-selrow-name">
                      {item.name} · {item.presentation}
                    </div>
                    <div
                      className="pub-selrow-mode"
                      style={{ color: pending ? "#B07A2A" : "var(--br-muted)" }}
                    >
                      {item.mode === "codigos" && item.codes
                        ? `Códigos: ${item.codes}`
                        : MODE_LABEL[item.mode]}
                    </div>
                    <div className="pub-selrow-controls">
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button
                          type="button"
                          className="pub-qtybtn-dec pub-qtybtn-dec--sm"
                          onClick={() => updateQty(index, -1)}
                        >
                          −
                        </button>
                        <span className="pub-selrow-qty">{item.qty}</span>
                        <button
                          type="button"
                          className="pub-qtybtn-inc pub-qtybtn-inc--sm"
                          onClick={() => updateQty(index, 1)}
                        >
                          ＋
                        </button>
                      </div>
                      <div className="pub-selrow-priceinfo">
                        <div className="pub-selrow-unit">
                          {formatSoles(price)} c/u{item.qty >= item.wholesaleMin ? " (mayor)" : ""}
                        </div>
                        <div className="pub-selrow-sub">{formatSoles(price * item.qty)}</div>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="pub-selrow-del"
                    title="Eliminar"
                    onClick={() => removeItem(index)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D98A8A" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0l1 13h8l1-13" />
                    </svg>
                  </button>
                </div>
              );
            })}

            <div className="pub-delivery">
              <div className="pub-delivery-title">Entrega</div>
              <div className="pub-delivery-opts">
                <button
                  type="button"
                  className={
                    delivery === "envio"
                      ? "pub-delivery-opt pub-delivery-opt--active"
                      : "pub-delivery-opt"
                  }
                  onClick={() => setDelivery("envio")}
                >
                  Envío
                  <br />
                  <span className="pub-delivery-optsub">Lima y provincias</span>
                </button>
                <button
                  type="button"
                  className={
                    delivery === "recojo"
                      ? "pub-delivery-opt pub-delivery-opt--active"
                      : "pub-delivery-opt"
                  }
                  onClick={() => setDelivery("recojo")}
                >
                  Recojo
                  <br />
                  <span className="pub-delivery-optsub">Tienda física, Lima</span>
                </button>
              </div>
              {delivery === "envio" ? (
                <input
                  className="pub-district"
                  value={district}
                  onChange={(event) => setDistrict(event.target.value)}
                  placeholder="Distrito (opcional) — ej. Miraflores"
                />
              ) : null}
            </div>

            <div className="pub-totals">
              <div className="pub-totals-row">
                <span>Total de unidades</span>
                <b>
                  {units} {units === 1 ? "unidad" : "unidades"}
                </b>
              </div>
              <div className="pub-totals-main">
                <span style={{ fontSize: "13.5px", color: "var(--br-nav-idle)" }}>
                  Subtotal referencial
                </span>
                <span className="pub-totals-price">{formatSoles(total)}</span>
              </div>
              <div className="pub-totals-note">
                {delivery === "envio"
                  ? "Tu asesor confirma stock, tonos pendientes y costo de envío por WhatsApp."
                  : "Tu asesor confirma stock y tonos pendientes, y coordina contigo el recojo en tienda por WhatsApp."}
              </div>
            </div>
          </div>

          <div className="pub-sel-cta">
            <a
              href={waLink(
                waNum,
                orderMessage("Hola Bellaroshé, quiero hacer este pedido:", items, delivery, district)
              )}
              target="_blank"
              rel="noopener"
              className="pub-sendwa"
            >
              <WaIcon size={18} />
              Enviar pedido por WhatsApp
            </a>
            <a
              href={waLink(
                waNum,
                orderMessage(
                  "Hola Bellaroshé, quisiera asesoría antes de confirmar este pedido:",
                  items,
                  delivery,
                  district
                )
              )}
              target="_blank"
              rel="noopener"
              className="pub-sendwa-asesor"
            >
              Primero quiero hablar con un asesor
            </a>
          </div>
        </>
      )}
    </div>
  );
}
