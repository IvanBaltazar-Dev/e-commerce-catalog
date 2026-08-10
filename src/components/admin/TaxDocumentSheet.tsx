"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { adminApi } from "@/lib/admin/api";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import {
  TAX_DOCUMENT_LABELS,
  taxDocumentProblem,
  type Sale,
  type TaxDocumentKind,
  type TaxDocumentRequirement
} from "@/lib/admin/sales";

/**
 * Solicitar boleta o factura para una venta ya registrada.
 *
 * DOS COSAS QUE ESTA PANTALLA NO HACE, y son la razón de que exista:
 *
 * 1. NO EMITE. Registra QUÉ comprobante quiere la clienta y a nombre de quién.
 *    La emisión es externa y su ciclo lo lleva `tax_document_requests`. La nota
 *    de venta sigue diciendo que no es comprobante autorizado.
 *
 * 2. NO HEREDA EL DOCUMENTO DE NADIE. Ni el de la compradora, ni el de quien
 *    recibe, ni el de quien recoge. Los campos arrancan vacíos. Sí hay un atajo
 *    para copiar los datos de la clienta —la mayoría de boletas van a su
 *    nombre— pero es un botón que alguien pulsa, no un relleno que ocurre solo:
 *    una factura a nombre de la empresa donde trabaja lleva un RUC que no es de
 *    ninguna persona que aparezca en la venta.
 *
 * Qué pide cada comprobante lo dice la base, no este archivo.
 */
export function TaxDocumentSheet({
  sale, onClose, onDone
}: {
  sale: Sale;
  onClose: () => void;
  onDone?: (sale: Sale) => void;
}) {
  const showToast = useToast();
  const handleApiError = useApiError();

  const [requirements, setRequirements] = useState<TaxDocumentRequirement[]>([]);
  const [kind, setKind] = useState<TaxDocumentKind | null>(null);
  const [taxId, setTaxId] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let vigente = true;
    adminApi.listTaxDocumentRequirements()
      .then((items) => { if (vigente) setRequirements(items); })
      .catch((error) => handleApiError(error, "No se pudo leer qué pide cada comprobante."));
    return () => { vigente = false; };
  }, [handleApiError]);

  const requirement = useMemo(
    () => requirements.find((item) => item.kind === kind) ?? null,
    [requirements, kind]
  );

  const problema = kind === null ? null : taxDocumentProblem({
    requirement, total: sale.total, receiver: { taxId, name, address }
  });

  /** El identificador solo es obligatorio a partir de cierto importe, y esa
   *  regla es de la base: aquí solo se refleja para no pedirlo con un asterisco
   *  cuando en realidad no hace falta. */
  const taxIdRequired = requirement?.taxIdRequiredFrom !== null
    && requirement !== null
    && sale.total >= (requirement.taxIdRequiredFrom ?? 0);

  function copiarDeLaClienta() {
    setName(sale.customerName ?? "");
    setTaxId(sale.customerDocument ?? "");
  }

  async function solicitar() {
    if (kind === null || saving) return;
    if (problema) { showToast(problema); return; }
    setSaving(true);
    try {
      const actualizada = await adminApi.requestTaxDocument(sale.id, {
        kind,
        receiver: {
          taxId: taxId.trim() || null,
          name: name.trim() || null,
          address: address.trim() || null
        }
      });
      showToast(`${TAX_DOCUMENT_LABELS[kind]} solicitada para ${sale.saleNumber} ✓`);
      onDone?.(actualizada);
      onClose();
    } catch (error) {
      handleApiError(error, "No se pudo registrar la solicitud del comprobante.");
    } finally {
      setSaving(false);
    }
  }

  // POR PORTAL Y POR ENCIMA. La pantalla de «venta registrada» del POS se pinta
  // en `document.body` con la misma capa que esta hoja, así que sin esto el
  // comprobante se abría DETRÁS: la vendedora pulsaba «Boleta o factura», algo
  // se abría donde no se veía, y la pantalla quedaba tapada y sin salida.
  return createPortal(
    <div
      className="tone-backdrop tone-backdrop--top"
      role="dialog"
      aria-modal="true"
      aria-label={`Comprobante de ${sale.saleNumber}`}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="sheet">
        <div className="shead">
          <h2>¿Qué documento lleva?</h2>
          <button type="button" className="xbtn" onClick={onClose} aria-label="Volver">×</button>
        </div>
        <div className="sbody">
          <div className="amtbig">
            <div className="k">Venta {sale.saleNumber}</div>
            <div className="v">S/ {sale.total.toFixed(2)}</div>
          </div>

          {/* Si ya se pidió uno, se dice: pedir otro lo REEMPLAZA, y quien lo
              hace tiene derecho a saberlo antes de escribir. */}
          {sale.taxDocument ? (
            <p className="entrega-falta" role="status">
              Esta venta ya tiene {TAX_DOCUMENT_LABELS[sale.taxDocument.kind].toLowerCase()} solicitada.
              Lo que registres aquí la reemplaza.
            </p>
          ) : null}

          {kind === null ? (
            <div className="paygrid">
              {requirements.map((item) => (
                <button key={item.kind} type="button" className="paym" onClick={() => setKind(item.kind)}>
                  {TAX_DOCUMENT_LABELS[item.kind]}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="chosen">
                <span className="ck" aria-hidden="true">✓</span>
                <span className="cm">{TAX_DOCUMENT_LABELS[kind]}</span>
                <span className="ca">S/ {sale.total.toFixed(2)}</span>
              </div>

              {requirement?.hint ? <p className="field-hint">{requirement.hint}</p> : null}

              {/* La nota de venta no pide nada: es el documento que la venta ya
                  lleva. Elegirla registra que la clienta no pidió comprobante,
                  que es un dato distinto de no haberle preguntado. */}
              {kind === "sales_note" ? null : (
              <>
              <label className="sale-field">
                <span>
                  {requirement?.taxIdLabel ?? "Documento"}
                  {taxIdRequired ? "" : " (opcional)"}
                </span>
                <input
                  className={taxIdRequired && taxId.trim() === "" ? "input input--falta" : "input"}
                  type="text"
                  inputMode="numeric"
                  value={taxId}
                  onChange={(event) => setTaxId(event.target.value)}
                  placeholder={requirement?.taxIdLabel === "RUC" ? "11 dígitos" : "8 dígitos"}
                  autoFocus
                />
              </label>

              <label className="sale-field">
                <span>{kind === "invoice" ? "Razón social" : "Nombre (opcional)"}</span>
                <input
                  className={requirement?.requiresName && name.trim() === "" ? "input input--falta" : "input"}
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={kind === "invoice" ? "Como figura en el RUC" : "A quién va la boleta"}
                />
              </label>

              {requirement?.requiresAddress ? (
                <label className="sale-field">
                  <span>Dirección fiscal</span>
                  <input
                    className={address.trim() === "" ? "input input--falta" : "input"}
                    type="text"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="La del RUC, no la de entrega"
                  />
                </label>
              ) : null}
              </>
              )}

              {/* El atajo, explícito. Solo aparece cuando hay algo que copiar y
                  cuando tiene sentido: una factura no va a nombre de la clienta. */}
              {kind === "sales_receipt" && (sale.customerName || sale.customerDocument) ? (
                <button type="button" className="linkline" onClick={copiarDeLaClienta}>
                  Usar los datos de {sale.customerName ?? "la clienta"}
                </button>
              ) : null}

              <button
                type="button"
                className="btn-save btn-full pay-confirm"
                disabled={saving}
                onClick={solicitar}
              >
                {saving ? <span className="spinner" /> : null}
                {saving ? "Registrando…" : problema ?? `Solicitar ${TAX_DOCUMENT_LABELS[kind].toLowerCase()}`}
              </button>
              <button type="button" className="linkline" onClick={() => setKind(null)}>
                Cambiar comprobante
              </button>
            </>
          )}

          <p className="field-hint">
            Se registra la solicitud. La emisión es un trámite aparte y la nota de venta
            no la reemplaza.
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}
