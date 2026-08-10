"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { adminApi } from "@/lib/admin/api";
import { useApiError } from "@/components/admin/useApiError";
import {
  availabilityLabel,
  isSellable,
  priceRangeLabel,
  toneTint,
  type PosTone,
  type PosToneSheet
} from "@/lib/admin/pos";
import { foldText } from "@/lib/public/tones";

type Tab = "recientes" | "vendidos" | "todos";

/**
 * Un círculo plano representa bien un cremoso y mal un glitter, un metálico o
 * un translúcido. Hasta que exista el recorte real del esmalte aplicado, el
 * acabado se insinúa con un degradado sobre el color registrado —como en el
 * prototipo— y se nombra siempre al lado, que es lo que no admite ambigüedad.
 */
function finishClass(finishLabel: string | null) {
  const f = (finishLabel ?? "").toLowerCase();
  if (f.includes("glitter") || f.includes("escarcha")) return " tone-dot--glitter";
  if (f.includes("metal") || f.includes("crom")) return " tone-dot--metal";
  if (f.includes("perl") || f.includes("nacar") || f.includes("tornasol")) return " tone-dot--pearl";
  if (f.includes("transl") || f.includes("transp") || f.includes("jelly")) return " tone-dot--sheer";
  return "";
}

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "recientes", label: "Tus recientes" },
  { key: "vendidos", label: "Más vendidos" },
  { key: "todos", label: "Todos" }
];

/**
 * Una casilla de la cuadrícula.
 *
 * `memo` no es una optimización cosmética aquí: es lo que sostiene la regla de
 * interacción. Con 164 tonos en pantalla, cada toque cambia el estado del
 * padre; sin memo, React volvería a pintar las 164 casillas y la clienta vería
 * parpadear toda la carta cada vez que elige un color. Con memo solo se repinta
 * la casilla cuyo contador cambió.
 */
const ToneCell = memo(function ToneCell({
  tone,
  count,
  onPick,
  onUnpick
}: {
  tone: PosTone;
  count: number;
  onPick: (tone: PosTone) => void;
  onUnpick: (tone: PosTone) => void;
}) {
  const vendible = isSellable(tone);
  const tint = toneTint(tone);
  const nombre = tone.shadeName ?? tone.variantName;

  // La tarjeta es un <div> y no un <button> porque lleva dentro sus propios
  // botones, y un botón no puede anidar otro. La zona de tocar sigue siendo
  // toda la tarjeta.
  return (
    <div className={`tone-cell-wrap${count > 0 ? " tone-cell-wrap--picked" : ""}${vendible ? "" : " tone-cell-wrap--out"}`}>
    <button
      type="button"
      className={`tone-cell${count > 0 ? " tone-cell--picked" : ""}${vendible ? "" : " tone-cell--out"}`}
      onClick={() => onPick(tone)}
      disabled={!vendible}
      title={`${nombre}${tone.shadeCode ? ` · ${tone.shadeCode}` : ""} · ${availabilityLabel(tone)}`}
    >
      <span className="tone-head-row">
        {/* El círculo es SIEMPRE color plano, nunca la foto de la variante.
            Las fotos que hay son del envase entero —tapa, etiqueta, reflejo del
            vidrio— y metidas en 22px devuelven el azul de la tapa, no el
            esmalte: justo lo que este selector viene a resolver. El acabado no
            se pierde, se insinúa con el degradado y se nombra al lado. */}
        <span
          className={`tone-dot tone-dot--flat${finishClass(tone.finishLabel)}`}
          style={tint ? { background: tint } : undefined}
        >
          {tint ? null : nombre.charAt(0).toUpperCase()}
        </span>
        <span className="tone-name">{nombre}</span>
      </span>
      <span className="tone-code">
        {tone.shadeCode ?? tone.sku ?? "—"}
        {tone.finishLabel ? <i className="tone-finish">{tone.finishLabel}</i> : null}
      </span>
      <span className="tone-stock">
        {tone.availability === "sold_out"
          ? "Agotado"
          : tone.unitPrice === null
            ? "Todavía sin precio"
            : tone.tracksInventory
              ? `${tone.availableQuantity} disponibles`
              : "Disponible"}
      </span>
    </button>

      {/* La fila de cantidad va DENTRO de la tarjeta y ocupa sitio siempre,
          esté o no elegido el tono: así todas las tarjetas miden lo mismo y la
          rejilla no se descoloca al ir sumando.
          Sin elegir, la tarjeta entera agrega y no hay botones que estorben.
          Con algo elegido aparecen los dos, menos y más, uno a cada lado del
          número: quitar deja de ser un control aparte que hay que buscar. */}
      <div className="tone-qty" aria-hidden={count === 0}>
        {count > 0 ? (
          <>
            <button
              type="button"
              className="tone-qty-btn"
              onClick={() => onUnpick(tone)}
              aria-label={`Quitar una unidad de ${nombre}. Llevas ${count}.`}
            >
              −
            </button>
            <span className="tone-qty-n">{count}</span>
            <button
              type="button"
              className="tone-qty-btn"
              onClick={() => onPick(tone)}
              disabled={!vendible}
              aria-label={`Agregar otra unidad de ${nombre}. Llevas ${count}.`}
            >
              +
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
});

/**
 * La tercera velocidad de la venta: «la clienta quiere elegir».
 *
 * Se abre con TODOS los tonos ya cargados. Nada de paginar: la cuadrícula no
 * puede recargarse mientras se selecciona, y ese es el requisito que manda.
 *
 * Elegir cuesta un toque: tocar el tono lo mete en la venta. No hay un segundo
 * «Agregar» porque entonces vender un esmalte serían cuatro pasos (teclear →
 * abrir → tocar → agregar) y el máximo son tres. El contador sobre el tono dice
 * cuántas unidades lleva, y tocar de nuevo suma otra.
 */
export function ToneSheet({
  branchId,
  productId,
  counts,
  onPick,
  onUnpick,
  onClearPicked,
  onClose
}: {
  branchId: string;
  productId: string;
  /** Unidades que ya lleva la venta, por variante. La hoja no guarda estado
   *  propio de cantidades: el carrito es el único dueño de ese número. */
  counts: Map<string, number>;
  onPick: (tone: PosTone, sheet: PosToneSheet) => void;
  /** Quita UNA unidad. La carta no decide cuántas quedan: solo pide restar. */
  onUnpick: (tone: PosTone) => void;
  onClearPicked: (variantIds: string[]) => void;
  onClose: () => void;
}) {
  const handleApiError = useApiError();

  const [sheet, setSheet] = useState<PosToneSheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("todos");
  const [family, setFamily] = useState<string | null>(null);
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [term, setTerm] = useState("");

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  /** Lo que ESTA apertura de la hoja metió en la venta: es lo que «Limpiar
   *  selección» deshace. No toca lo que ya venía de antes. */
  const pickedHereRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminApi
      .getToneSheet(branchId, productId)
      .then((result) => {
        if (cancelled) return;
        setSheet(result);
        // Si la vendedora tiene recientes de este producto, esa es la pestaña
        // útil. Si no, abrirla vacía sería enseñarle un cajón sin nada.
        const conRecientes = result.tones.some((tone) => tone.lastSoldAt !== null);
        setTab(conRecientes ? "recientes" : "todos");
      })
      .catch((error) => {
        if (!cancelled) handleApiError(error, "No se pudieron abrir los tonos de este producto.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, productId, handleApiError]);

  // Foco automático en el buscador interno: con 164 tonos, quien sabe el nombre
  // teclea antes de mirar.
  useEffect(() => {
    if (!loading) searchRef.current?.focus();
  }, [loading]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * La lista visible depende SOLO de los filtros. No depende de la selección, y
   * por eso la cuadrícula no puede reordenarse ni encogerse mientras la clienta
   * elige: es imposible por construcción, no por cuidado al escribir el código.
   */

  const visible = useMemo(() => {
    if (!sheet) return [] as PosTone[];
    // Sin tildes: media carta de Masglo las lleva («Arcoíris», «Auténtica»,
    // «Bombón») y en mostrador nadie las teclea.
    const buscado = foldText(term.trim());

    let lista = sheet.tones;
    if (tab === "recientes") {
      lista = lista
        .filter((tone) => tone.lastSoldAt !== null)
        .slice()
        .sort((a, b) => (b.lastSoldAt ?? "").localeCompare(a.lastSoldAt ?? ""));
    } else if (tab === "vendidos") {
      lista = lista.filter((tone) => tone.soldUnits > 0).slice().sort((a, b) => b.soldUnits - a.soldUnits);
    }

    return lista.filter((tone) => {
      if (family && tone.familyValue !== family) return false;
      if (onlyAvailable && !isSellable(tone)) return false;
      if (buscado) {
        const heno = `${tone.shadeName ?? ""} ${tone.variantName} ${tone.shadeCode ?? ""} ${tone.sku ?? ""}`;
        if (!foldText(heno).includes(buscado)) return false;
      }
      return true;
    });
  }, [sheet, tab, family, onlyAvailable, term]);

  // Al recargar la hoja (cambia el stock tras agregar) la cuadrícula se vuelve
  // a pintar entera. Sin esto, la vendedora que estaba abajo del todo aparece
  // de golpe arriba y pierde dónde iba.
  useLayoutEffect(() => {
    if (gridRef.current && scrollTopRef.current > 0) {
      gridRef.current.scrollTop = scrollTopRef.current;
    }
  }, [sheet]);

  // Cambiar de filtro sí es una lista nueva: ahí empezar por arriba es lo
  // correcto, y se hace explícito en vez de dejarlo al azar del navegador.
  useLayoutEffect(() => {
    if (gridRef.current) {
      gridRef.current.scrollTop = 0;
      scrollTopRef.current = 0;
    }
  }, [tab, family, onlyAvailable, term]);

  const pick = useCallback(
    (tone: PosTone) => {
      if (!sheet) return;
      pickedHereRef.current.add(tone.variantId);
      onPick(tone, sheet);
    },
    [onPick, sheet]
  );

  const enLaVenta = visible.reduce((sum, tone) => sum + (counts.get(tone.variantId) ?? 0), 0);
  const tonosEnLaVenta = visible.filter((tone) => (counts.get(tone.variantId) ?? 0) > 0).length;
  const desdeAqui = [...pickedHereRef.current].filter((id) => (counts.get(id) ?? 0) > 0);

  const cabecera = sheet?.product ?? null;

  // Al cuerpo del documento, no donde se declara. `.br-fade` anima la página
  // con un transform, y un ancestro transformado convierte cualquier
  // `position: fixed` de dentro en relativo a él: en móvil la hoja salía de
  // 347 px en una pantalla de 412 en vez de ocuparla entera.
  return createPortal(
    <div className="tone-backdrop" role="dialog" aria-modal="true" aria-label="Elegir tono">
      <section className="tone-sheet">
        <header className="tone-head">
          <div className="tone-head-main">
            <div className="tone-title">{cabecera?.name ?? "Cargando…"}</div>
            <div className="tone-sub">
              {cabecera ? (
                <>
                  {cabecera.brandName}
                  {cabecera.presentation ? ` · ${cabecera.presentation}` : ""}
                  {" · "}
                  <b>{cabecera.toneCount} tonos</b>
                  {" · "}
                  {cabecera.availableCount} disponibles
                  {" · "}
                  {priceRangeLabel(cabecera)}
                </>
              ) : null}
            </div>
          </div>
          <button type="button" className="tone-close" onClick={onClose} aria-label="Cerrar los tonos">
            ×
          </button>
        </header>

        {/* Deuda visible, no disimulada: si el catálogo aún no tiene precio en
            parte de la carta, la vendedora tiene que saberlo antes de que la
            clienta elija un tono que no se le puede cobrar. */}
        {cabecera && cabecera.withoutPrice > 0 ? (
          <p className="tone-warning">
            {cabecera.withoutPrice} de {cabecera.toneCount} tonos todavía no tienen precio: se ven, pero no se
            pueden vender hasta que la dueña se lo ponga.
          </p>
        ) : null}

        <div className="tone-controls">
          <input
            ref={searchRef}
            className="input tone-search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Buscar tono, código o SKU dentro de este producto…"
          />
          <div className="tone-tabs" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={tab === item.key ? "tone-tab tone-tab--on" : "tone-tab"}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
            <label className="tone-toggle">
              <input
                type="checkbox"
                checked={onlyAvailable}
                onChange={(event) => setOnlyAvailable(event.target.checked)}
              />
              Solo disponibles
            </label>
          </div>


        </div>

        {/* Riel de familias JUNTO a la rejilla, no encima de ella.
         *
         * Las catorce quedan visibles sin desplegar ni arrastrar, y al vivir en
         * una columna lateral no le quitan alto a los tonos, que es lo que se
         * viene a mirar. El orden de lectura es el que importa: se baja por la
         * columna de colores y solo se lee la fila a la que ya se apunta —el
         * color busca, la palabra confirma—. Cada fila lleva su cuenta pegada,
         * así que color, cantidad y estado entran de un golpe de vista.
         *
         * En celular no caben 176px de riel: pasa a dos columnas encima de la
         * rejilla, con las mismas filas y el mismo orden. Lo resuelve el CSS,
         * no un segundo componente. */}
        <div className="tone-main">
          {sheet && sheet.families.length > 1 ? (
            <nav className="tone-rail" aria-label="Familia cromática">
              {/* Tocar una familia lleva SIEMPRE a «Todos».
                *
                * El riel significa «todos los tonos de esta gama», y su cuenta
                * está calculada sobre el producto entero. Si al tocarlo siguiera
                * activa la pestaña «Tus recientes», el riel prometería 20 rojos
                * y la rejilla enseñaría dos: el número dejaría de creerse. */}
              <button
                type="button"
                className="tone-rail-btn"
                aria-pressed={family === null}
                onClick={() => { setFamily(null); setTab("todos"); }}
              >
                <span className="tone-rail-all" aria-hidden="true" />
                <span className="tone-rail-txt">Todas</span>
                <span className="tone-rail-n">
                  {onlyAvailable
                    ? sheet.tones.filter((tone) => isSellable(tone)).length
                    : sheet.tones.length}
                </span>
              </button>
              {sheet.families.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className="tone-rail-btn"
                  aria-pressed={family === item.value}
                  onClick={() => { setFamily(family === item.value ? null : item.value); setTab("todos"); }}
                >
                  <span
                    className={`tone-family-dot${item.value === "multicolor" ? " tone-family-dot--multi" : ""}`}
                    style={{ background: toneTint({ referenceColor: null, familyValue: item.value }) ?? undefined }}
                  />
                  <span className="tone-rail-txt">{item.label}</span>
                  <span className="tone-rail-n">{onlyAvailable ? item.availableCount : item.toneCount}</span>
                </button>
              ))}
            </nav>
          ) : null}

        <div className="tone-grid" ref={gridRef} onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop; }}>
          {loading ? (
            <div className="tone-empty"><span className="spinner spinner--pink" /> Abriendo la carta de tonos…</div>
          ) : visible.length === 0 ? (
            <div className="tone-empty">
              {tab === "recientes"
                ? "Todavía no has despachado ningún tono de este producto."
                : tab === "vendidos"
                  ? "Aún no hay ventas de este producto en la tienda."
                  : onlyAvailable
                    ? "Ningún tono disponible con ese filtro. Quita «Solo disponibles» para ver el resto de la carta."
                    : "Ningún tono coincide."}
            </div>
          ) : (
            visible.map((tone) => (
              <ToneCell
                key={tone.variantId}
                tone={tone}
                count={counts.get(tone.variantId) ?? 0}
                onPick={pick}
                onUnpick={onUnpick}
              />
            ))
          )}
        </div>
        </div>

        <footer className="tone-foot">
          <span className="tone-foot-count">
            {enLaVenta === 0 ? (
              "Toca un tono para agregarlo a la venta"
            ) : (
              <>
                <b>{tonosEnLaVenta}</b> {tonosEnLaVenta === 1 ? "tono" : "tonos"} · <b>{enLaVenta}</b>{" "}
                {enLaVenta === 1 ? "unidad" : "unidades"} en la venta
              </>
            )}
          </span>
          {desdeAqui.length > 0 ? (
            <button type="button" className="btn-ghost" onClick={() => { onClearPicked(desdeAqui); pickedHereRef.current.clear(); }}>
              Limpiar selección
            </button>
          ) : null}
          <button type="button" className="btn-save" onClick={onClose}>
            Listo
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
