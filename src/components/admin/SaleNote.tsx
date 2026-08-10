"use client";

import { useMemo } from "react";
import type { Sale, SaleLine } from "@/lib/admin/sales";
import { PAYMENT_METHOD_LABELS, requiresOperationNumber } from "@/lib/admin/sales";

/**
 * Nota de venta de 80 mm.
 *
 * Es una NOTA DE VENTA, no una boleta: lleva su leyenda de documento interno y
 * no aparenta ser un comprobante autorizado. El comprobante fiscal es otro
 * módulo (`tax_document_kind`), y confundirlos sería exactamente el problema.
 *
 * Compactación, que es el criterio de aceptación: se agrupa por PRODUCTO y
 * precio aplicado. Un esmalte con 25 tonos ocupa un bloque de tres líneas, no
 * 25 líneas. Los tonos fluyen separados por `·` y saltan solos.
 *
 * Ninguna cifra se escribe a mano: importe = unidades × precio aplicado,
 * subtotal = suma de bloques, vuelto = lo que el cobro ya calculó. Escribirlas
 * a mano ya produjo dos errores reales.
 */

const NEGOCIO = {
  nombre: "IMPORTACIONES BELLAROSHÉ",
  // RUC y dirección son MARCADORES a propósito: salen de Administración →
  // Organización cuando existan. Un RUC inventado impreso es justo lo que no
  // puede pasar.
  ruc: null as string | null,
  direccion: null as string | null,
  whatsapp: "963 463 550",
  sitio: "bellaroshe.pe"
};

function S(value: number) {
  return value.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type Bloque = {
  clave: string;
  producto: string;
  tonos: Array<{ cantidad: number; nombre: string; sku: string | null }>;
  unidades: number;
  precioAplicado: number;
  importe: number;
  mayorista: boolean;
};

/** Agrupa por producto + precio aplicado. Dos precios distintos del mismo
 *  producto son dos bloques: si no, la línea económica no cuadraría. */
function agrupar(lines: SaleLine[]): Bloque[] {
  const bloques = new Map<string, Bloque>();
  for (const line of lines) {
    const producto = line.productName ?? "Producto";
    const clave = `${producto}|${line.unitPrice}|${line.purchaseMode}`;
    const actual = bloques.get(clave);
    const tono = {
      cantidad: line.quantity,
      nombre: line.variantName ?? "Única",
      sku: line.sku
    };
    if (actual) {
      actual.tonos.push(tono);
      actual.unidades += line.quantity;
      actual.importe += line.subtotal;
    } else {
      bloques.set(clave, {
        clave,
        producto,
        tonos: [tono],
        unidades: line.quantity,
        precioAplicado: line.unitPrice,
        importe: line.subtotal,
        mayorista: line.purchaseMode === "wholesale"
      });
    }
  }
  return [...bloques.values()];
}

export function SaleNote({ sale, printSku = false }: { sale: Sale; printSku?: boolean }) {
  const bloques = useMemo(() => agrupar(sale.lines), [sale.lines]);
  const unidades = bloques.reduce((sum, bloque) => sum + bloque.unidades, 0);
  const subtotal = bloques.reduce((sum, bloque) => sum + bloque.importe, 0);
  const vuelto = sale.payments.reduce((sum, pago) => sum + (pago.change ?? 0), 0);
  const adelanto = sale.payments
    .filter((pago) => pago.fromReservation)
    .reduce((sum, pago) => sum + pago.amount, 0);

  // Como mucho hay uno: un destinatario y un autorizado a recoger no conviven,
  // porque son el mismo momento de la entrega visto desde dos métodos distintos.
  const entrega = sale.parties?.[0] ?? null;

  // Lo COBRADO sale de los pagos; lo que falta, del contrato. Nunca se restan
  // aquí: `sale_detail` ya lo resuelve y una segunda aritmética del mismo dinero
  // es una que puede discrepar. Los `??` son para notas de ventas anteriores a
  // 0063, que no traen estos campos.
  const cobrado = sale.paidTotal ?? sale.payments.reduce((sum, pago) => sum + pago.amount, 0);
  const pendiente = sale.balance ?? sale.total - cobrado;
  const anulada = sale.status === "cancelled";

  const emitida = new Date(sale.issuedAt);
  const fecha = emitida.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const hora = emitida.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="ticket">
      {/* El logo con su proporción exacta (360×209 del original). Ancho fijo en
          milímetros y alto derivado: en 80 mm de papel, escalar «a ojo» deforma
          la marca y se nota más impresa que en pantalla. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="tk-logo"
        src="/brand/logo.png"
        alt={NEGOCIO.nombre}
        width={360}
        height={209}
      />
      <div className="tk-c tk-sm">{NEGOCIO.ruc ? `RUC ${NEGOCIO.ruc}` : "RUC — por configurar"}</div>
      <div className="tk-c tk-sm">{NEGOCIO.direccion ?? "Dirección — por configurar"}</div>
      <div className="tk-c tk-sm">WhatsApp {NEGOCIO.whatsapp}</div>

      <div className="tk-rule tk-rule--thick" />
      <div className="tk-c tk-kind">NOTA DE VENTA</div>
      <div className="tk-c tk-folio">{sale.saleNumber}</div>
      {/* Una venta anulada que se reimprime tiene que decirlo en la cabecera. Un
          ticket idéntico al de una venta viva es el que acaba usándose para
          reclamar una entrega que ya no existe. */}
      {anulada ? <div className="tk-c tk-void">ANULADA</div> : null}
      <div className="tk-rule tk-rule--dash" />

      <div className="tk-meta"><span>{fecha}</span><span>{hora}</span></div>
      <div className="tk-sm">Atendió: {sale.sellerLabel ?? "—"}</div>
      {/* Solo cuando corresponde: en mostrador no se pregunta el nombre, y
          «Cliente: sin identificar» no informa de nada. */}
      {sale.customerName ? <div className="tk-sm">Cliente: {sale.customerName}</div> : null}

      {/* Quién recibe solo se imprime cuando es una pregunta real: en mostrador
          se le da la bolsa a quien está delante. Y si recibe la propia clienta,
          repetir su nombre dos líneas más abajo no informa de nada. */}
      {entrega && !entrega.isBuyer ? (
        <>
          <div className="tk-sm tk-b">
            {entrega.role === "pickup_authorized" ? "Recoge" : "Recibe"}: {entrega.fullName}
          </div>
          {entrega.documentNumber ? (
            <div className="tk-sm">Doc: {entrega.documentNumber}</div>
          ) : null}
          {entrega.phone ? <div className="tk-sm">Tel: {entrega.phone}</div> : null}
        </>
      ) : null}
      {entrega?.address ? <div className="tk-sm">Entregar en: {entrega.address}</div> : null}

      <div className="tk-rule" />
      <div className="tk-row tk-head"><span>PRODUCTO / TONOS</span><span className="tk-r">IMPORTE</span></div>
      <div className="tk-rule tk-rule--dash" />

      {bloques.map((bloque) => (
        <div key={bloque.clave} className="tk-prod">
          <div className="tk-pn">{bloque.producto}</div>
          <div className="tk-tones">
            {bloque.tonos
              .map((tono) =>
                `${tono.cantidad}× ${tono.nombre}${printSku && tono.sku ? ` (${tono.sku})` : ""}`)
              .join(" · ")}
          </div>
          <div className="tk-row tk-b">
            <span>{bloque.unidades} × S/ {S(bloque.precioAplicado)}</span>
            <span className="tk-r">S/ {S(bloque.importe)}</span>
          </div>
        </div>
      ))}

      <div className="tk-rule tk-rule--dash" />
      <div className="tk-row"><span>{unidades} {unidades === 1 ? "unidad" : "unidades"}</span></div>
      <div className="tk-row"><span>Subtotal</span><span className="tk-r">S/ {S(subtotal)}</span></div>
      {sale.discountTotal > 0.004 ? (
        <div className="tk-row"><span>Descuento</span><span className="tk-r">- S/ {S(sale.discountTotal)}</span></div>
      ) : null}
      {adelanto > 0.004 ? (
        <div className="tk-row"><span>Adelanto de reserva</span><span className="tk-r">S/ {S(adelanto)}</span></div>
      ) : null}

      <div className="tk-rule" />
      <div className="tk-totrow"><span className="tk-tot">TOTAL</span><span className="tk-tot">S/ {S(sale.total)}</span></div>
      <div className="tk-rule" />

      {/* Cada medio con su importe: en un pago dividido, «pagado S/ 40» sin
          decir cuánto por Yape y cuánto en efectivo no sirve para cuadrar caja
          ni para que la clienta reconozca su operación. */}
      {sale.payments.map((pago) => (
        <div key={pago.id} className="tk-row">
          <span>
            {PAYMENT_METHOD_LABELS[pago.method]}
            {/* El código solo acompaña a los medios que lo llevan. El adelanto
                trasladado guarda en `reference` el texto «Adelanto de RES-…»,
                y anexarlo repetía la palabra dos veces en la misma línea. */}
            {requiresOperationNumber(pago.method) && pago.reference ? ` ·${pago.reference}` : ""}
          </span>
          <span className="tk-r">S/ {S(pago.amount)}</span>
        </div>
      ))}
      {vuelto > 0.004 ? (
        <div className="tk-row tk-b"><span>VUELTO</span><span className="tk-r">S/ {S(vuelto)}</span></div>
      ) : null}

      {/* Contra entrega. Lo cobrado y lo que falta van SEPARADOS y con nombres
          distintos: si el ticket dijera solo «Total S/ 50» junto a los pagos,
          quien lo recibe puede leer que ya pagó los 50. Lo que se debe se
          imprime en su propia línea y se dice cuándo se cobra. */}
      {pendiente > 0.004 ? (
        <>
          <div className="tk-rule tk-rule--dash" />
          <div className="tk-row tk-b"><span>Cobrado a cuenta</span><span className="tk-r">S/ {S(cobrado)}</span></div>
          <div className="tk-row tk-b tk-debe">
            <span>FALTA POR PAGAR</span><span className="tk-r">S/ {S(pendiente)}</span>
          </div>
          <div className="tk-c tk-sm">Se cobra al recibir el pedido.</div>
        </>
      ) : null}

      {sale.taxDocument ? (
        <>
          <div className="tk-rule tk-rule--dash" />
          <div className="tk-c tk-b">
            {sale.taxDocument.kind === "invoice" ? "FACTURA SOLICITADA" : "BOLETA SOLICITADA"}
          </div>
          <div className="tk-c tk-sm">Pendiente de emisión</div>
        </>
      ) : null}

      <div className="tk-rule" />
      <div className="tk-c tk-sm tk-b">Consulta tu compra</div>
      <div className="tk-c tk-sm">{NEGOCIO.sitio}/v/{sale.saleNumber}</div>

      <div className="tk-legend">
        DOCUMENTO INTERNO DE CONTROL<br />
        No es comprobante de pago electrónico<br />
        autorizado por SUNAT.<br />
        Si necesita boleta o factura, solicítela<br />
        al momento de la compra.
      </div>

      <div className="tk-c tk-thanks">¡GRACIAS POR TU COMPRA!</div>
      <div className="tk-c tk-sm">WhatsApp {NEGOCIO.whatsapp}</div>
      <div style={{ height: "6mm" }} />
    </div>
  );
}
