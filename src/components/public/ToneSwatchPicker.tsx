"use client";
/* eslint-disable @next/next/no-img-element */

// Carta de colores, no galería de envases.
//
// Con 164 tonos, una rejilla de fotografías de frascos gasta toda la pantalla
// en vidrio, tapa y etiqueta —lo único que los 164 tienen en común— y deja el
// color, que es lo que los distingue, reducido a unos pocos píxeles. Aquí la
// casilla ES el color: 44px de área táctil (mínimo de la W3C) con el tono
// dentro, sin nombre debajo. El nombre no se pierde: vive en el pie, que
// siempre muestra el tono elegido, y aparece al apuntar a cualquier otro.
//
// La fotografía del envase no desaparece: pasa a donde sirve, que es el área
// grande de producto. Ahí confirma lo elegido; no es forma de navegar entre
// 164 opciones.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { publicAssetUrl } from "@/lib/admin/api";
import type { PurchasableVariant } from "@/lib/catalog/contracts";
import { relativeLuminance, sortToneCells, toToneCell, type ToneCell } from "@/lib/public/tones";

const ALL = "__todos__";

function CheckMark({ fill }: { fill: string }) {
  // Blanca sobre tonos oscuros, tinta sobre los claros: una marca fija se
  // vuelve invisible sobre la mitad de la carta.
  const stroke = relativeLuminance(fill) > 0.5 ? "#241621" : "#ffffff";
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M4.5 12.5 9.5 17.5 19.5 7" fill="none" stroke={stroke} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M16 16 21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ToneSwatchPicker({
  variants,
  selectedId,
  onSelect
}: {
  variants: PurchasableVariant[];
  selectedId: string;
  onSelect: (variant: PurchasableVariant) => void;
}) {
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState(ALL);
  const [finish, setFinish] = useState(ALL);
  const [hovered, setHovered] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const cells = useMemo(() => sortToneCells(variants.map(toToneCell)), [variants]);

  // Solo las familias PRESENTES en este producto. Ofrecer «Azules» en un
  // esmalte sin azules es una pantalla que miente.
  const families = useMemo(() => {
    const counts = new Map<string, { label: string; sort: number; total: number }>();
    for (const cell of cells) {
      const entry = counts.get(cell.familyValue);
      if (entry) entry.total += 1;
      else counts.set(cell.familyValue, { label: cell.familyLabel, sort: cell.familySort, total: 1 });
    }
    return [...counts.entries()]
      .map(([value, entry]) => ({ value, ...entry }))
      .sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label, "es"));
  }, [cells]);

  // El acabado solo se ofrece si hay más de uno que elegir. Hoy ninguna
  // variante tiene `finish_type` cargado, así que el control no se dibuja; el
  // día que la dueña los registre aparece solo, sin tocar esta pantalla.
  const finishes = useMemo(() => {
    const counts = new Map<string, string>();
    for (const cell of cells) if (cell.finishValue) counts.set(cell.finishValue, cell.finishLabel ?? cell.finishValue);
    return [...counts.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [cells]);

  const needle = query.trim();
  const folded = useMemo(() => needle.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase(), [needle]);

  const visible = useMemo(
    () => cells.filter((cell) => {
      if (family !== ALL && cell.familyValue !== family) return false;
      if (finish !== ALL && cell.finishValue !== finish) return false;
      if (folded && !cell.haystack.includes(folded)) return false;
      return true;
    }),
    [cells, family, finish, folded]
  );

  // Un CAMBIO de filtro devuelve la rejilla al principio: son resultados
  // nuevos. Elegir un tono NO mueve el scroll ni reordena nada.
  //
  // Se compara la combinación aplicada en vez de usar un «ya pasé por aquí»:
  // en desarrollo React ejecuta cada efecto dos veces al montar, y con una
  // bandera simple la segunda pasada devolvía el panel a cero justo después de
  // que el efecto de abajo lo hubiera colocado sobre el tono elegido. Con la
  // firma, una repetición idéntica no es un cambio y no mueve nada.
  const appliedFiltersRef = useRef<string | null>(null);
  useEffect(() => {
    const signature = `${family}|${finish}|${folded}`;
    if (appliedFiltersRef.current === signature) return;
    const firstRun = appliedFiltersRef.current === null;
    appliedFiltersRef.current = signature;
    if (!firstRun && gridRef.current) gridRef.current.scrollTop = 0;
  }, [family, finish, folded]);

  // Al abrir la ficha, la rejilla se coloca sobre el tono elegido. Con 15 filas
  // y solo 4 a la vista, el tono que llega por enlace —o el predeterminado del
  // producto— caería fuera de la ventana y el panel parecería no tener nada
  // marcado. Se hace una sola vez y moviendo únicamente el panel: si se
  // recolocara en cada selección, elegir movería la carta bajo el dedo.
  const revealedRef = useRef(false);
  useEffect(() => {
    if (revealedRef.current) return;
    let timer = 0;
    let attempts = 0;
    const place = () => {
      const grid = gridRef.current;
      const node = grid?.querySelector<HTMLElement>('[aria-checked="true"]');
      // Mientras la hoja de estilo no ha limitado la altura del panel, este no
      // desborda, y asignar `scrollTop` sobre algo que no desborda lo deja en
      // cero. Por eso se reintenta hasta que haya algo que desplazar. Con
      // temporizador y no con `requestAnimationFrame`: una pestaña en segundo
      // plano no pinta fotogramas, y la ficha abierta en otra pestaña se
      // encontraría el panel sin colocar.
      if (grid && node && grid.scrollHeight > grid.clientHeight) {
        revealedRef.current = true;
        const gridBox = grid.getBoundingClientRect();
        const nodeBox = node.getBoundingClientRect();
        grid.scrollTop += nodeBox.top - gridBox.top - (grid.clientHeight - nodeBox.height) / 2;
        return;
      }
      if (attempts++ < 12) timer = window.setTimeout(place, 20);
    };
    place();
    return () => window.clearTimeout(timer);
  }, [selectedId]);

  const selected = cells.find((cell) => cell.variant.id === selectedId) ?? cells[0] ?? null;
  const selectedIsVisible = visible.some((cell) => cell.variant.id === selectedId);
  const preview = hovered ? cells.find((cell) => cell.variant.id === hovered) ?? null : null;
  const readout = preview && preview.variant.id !== selected?.variant.id ? preview : null;

  function moveFocus(from: number, delta: number) {
    const next = from + delta;
    if (next < 0 || next >= visible.length) return;
    const node = gridRef.current?.querySelector<HTMLButtonElement>(`[data-tone-index="${next}"]`);
    node?.focus();
    node?.scrollIntoView({ block: "nearest" });
    onSelect(visible[next].variant);
  }

  function columnsPerRow() {
    const grid = gridRef.current;
    if (!grid) return 1;
    const items = [...grid.querySelectorAll<HTMLElement>("[data-tone-index]")];
    if (items.length === 0) return 1;
    const first = items[0].offsetTop;
    const index = items.findIndex((item) => item.offsetTop > first);
    return index === -1 ? items.length : index;
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const raw = target.getAttribute?.("data-tone-index");
    if (raw === null || raw === undefined) return;
    const index = Number(raw);
    const columns = columnsPerRow();
    const step =
      event.key === "ArrowRight" ? 1
      : event.key === "ArrowLeft" ? -1
      : event.key === "ArrowDown" ? columns
      : event.key === "ArrowUp" ? -columns
      : event.key === "Home" ? -index
      : event.key === "End" ? visible.length - 1 - index
      : null;
    if (step === null) return;
    event.preventDefault();
    moveFocus(index, step);
  }

  const total = cells.length;

  return (
    <section className="pub-tones" aria-labelledby="pub-tones-title">
      <div className="pub-tones-head">
        <h2 className="pub-tones-title" id="pub-tones-title">Elige un tono</h2>
        {/* Mismo hueco para las dos cosas: al apuntar un tono el recuento cede
            su sitio al nombre. Así el nombre existe sin gastar una línea. */}
        <span className={readout ? "pub-tones-count pub-tones-count--tone" : "pub-tones-count"}>
          {readout ? `${readout.name} · ${readout.code}` : `${total} ${total === 1 ? "tono" : "tonos"}`}
        </span>
      </div>

      <div className="pub-tones-search">
        <SearchIcon />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar tono o código…"
          aria-label="Buscar tono por nombre, código o SKU"
          aria-controls="pub-tones-grid"
        />
        {needle ? <button type="button" className="pub-tones-clear" onClick={() => setQuery("")}>Limpiar</button> : null}
      </div>

      {families.length > 1 ? (
        <div className="pub-tones-families" role="group" aria-label="Filtrar por familia cromática">
          <button type="button" className={family === ALL ? "pub-tones-chip pub-tones-chip--on" : "pub-tones-chip"} aria-pressed={family === ALL} onClick={() => setFamily(ALL)}>
            Todos
          </button>
          {families.map((item) => (
            <button
              key={item.value}
              type="button"
              className={family === item.value ? "pub-tones-chip pub-tones-chip--on" : "pub-tones-chip"}
              aria-pressed={family === item.value}
              onClick={() => setFamily(family === item.value ? ALL : item.value)}
            >
              {item.label}
              <span className="pub-tones-chipnum">{item.total}</span>
            </button>
          ))}
        </div>
      ) : null}

      {finishes.length > 1 ? (
        <label className="pub-tones-finish">
          Acabado
          <select value={finish} onChange={(event) => setFinish(event.target.value)}>
            <option value={ALL}>Todos</option>
            {finishes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      ) : null}

      {visible.length === 0 ? (
        <div className="pub-tones-empty">
          <div className="pub-tones-empty-title">Ningún tono coincide</div>
          <div className="pub-tones-empty-sub">Prueba con otro nombre o código.</div>
          <button type="button" className="pub-tones-reset" onClick={() => { setQuery(""); setFamily(ALL); setFinish(ALL); }}>
            Ver los {total} tonos
          </button>
        </div>
      ) : (
        <div
          className="pub-tones-grid"
          id="pub-tones-grid"
          ref={gridRef}
          role="radiogroup"
          aria-label={`Tonos disponibles: ${visible.length} de ${total}`}
          onKeyDown={onGridKeyDown}
          onMouseLeave={() => setHovered(null)}
        >
          {visible.map((cell, index) => {
            const active = cell.variant.id === selectedId;
            // Tabulación itinerante: un solo tono entra en el orden de
            // tabulación y las flechas recorren el resto. 164 paradas de
            // tabulador serían una trampa para quien navega con teclado.
            const tabStop = active || (index === 0 && !selectedIsVisible);
            return (
              <button
                key={cell.variant.id}
                type="button"
                data-tone-index={index}
                role="radio"
                aria-checked={active}
                tabIndex={tabStop ? 0 : -1}
                className={toneClass(cell, active)}
                style={{ "--tone-fill": cell.fill } as CSSProperties}
                title={`${cell.name} · ${cell.code}${cell.soldOut ? " · agotado" : ""}`}
                aria-label={toneLabel(cell)}
                onClick={() => onSelect(cell.variant)}
                onMouseEnter={() => setHovered(cell.variant.id)}
                onFocus={() => setHovered(cell.variant.id)}
                onBlur={() => setHovered(null)}
              >
                <span className="pub-tone-chip">
                  {cell.texture ? (
                    <img src={publicAssetUrl(cell.texture)} alt="" loading="lazy" decoding="async" />
                  ) : null}
                  {active ? <CheckMark fill={cell.fill} /> : null}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selected ? (
        <div className="pub-tones-picked" aria-live="polite">
          <span className={selected.isPale ? "pub-tone-chip pub-tone-chip--pale pub-tone-chip--lg" : "pub-tone-chip pub-tone-chip--lg"} style={{ "--tone-fill": selected.fill } as CSSProperties} aria-hidden="true">
            {selected.texture ? <img src={publicAssetUrl(selected.texture)} alt="" /> : null}
          </span>
          <span className="pub-tones-picked-text">
            <span className="pub-tones-picked-name">{selected.name}</span>
            <span className="pub-tones-picked-meta">
              SKU {selected.sku}
              {selected.code !== selected.sku ? ` · ${selected.code}` : ""}
              {selected.finishLabel ? ` · ${selected.finishLabel}` : ""}
              {" · "}
              {selected.variant.availability === "available" ? "Disponible"
                : selected.variant.availability === "sold_out" ? "Agotado"
                : "Consultar"}
            </span>
            {selected.isReference ? (
              <span className="pub-tones-picked-ref">
                Color referencial de la familia {selected.familyLabel.toLowerCase()}: este tono aún no tiene su color registrado.
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function toneClass(cell: ToneCell, active: boolean) {
  const classes = ["pub-tone"];
  if (active) classes.push("pub-tone--on");
  if (cell.isPale) classes.push("pub-tone--pale");
  if (cell.isReference) classes.push("pub-tone--ref");
  if (cell.soldOut) classes.push("pub-tone--out");
  return classes.join(" ");
}

// El color no puede ser la única forma de distinguir una opción: el nombre, el
// código y el estado viajan siempre en el nombre accesible.
function toneLabel(cell: ToneCell) {
  const parts = [cell.name, cell.code, cell.familyLabel];
  if (cell.finishLabel) parts.push(cell.finishLabel);
  if (cell.isReference) parts.push("color referencial");
  if (cell.soldOut) parts.push("agotado");
  return parts.join(", ");
}
