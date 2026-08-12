"use client";

import { useMemo, useState } from "react";
import { CatalogBulkImportView } from "@/components/admin/CatalogBulkImportView";
import { CatalogImportView } from "@/components/admin/CatalogImportView";

type SectionId =
  | "inicio"
  | "reconciliar"
  | "cobertura"
  | "imagenes"
  | "campo"
  | "reglas"
  | "auditoria"
  | "fuentes";

type DecisionStatus = "EXACTO" | "PROBABLE_EXISTENTE" | "CONFLICTO" | "INSUFICIENTE";
type SourceMode = "resumen" | "masiva" | "plantilla";
type ImageDecision = "pending" | "approved" | "held";

type DecisionField = {
  key: string;
  label: string;
  source: string;
  current: string;
  proposal: string;
};

type CatalogDecision = {
  id: string;
  title: string;
  subtitle: string;
  status: DecisionStatus;
  confidence: number | null;
  reason: string;
  sourceLabel: string;
  sourceDetail: string;
  destination: string;
  fields: DecisionField[];
};

const SECTIONS: Array<{ id: SectionId; label: string; short: string }> = [
  { id: "inicio", label: "Pulso", short: "Pulso" },
  { id: "reconciliar", label: "Reconciliar", short: "Decidir" },
  { id: "cobertura", label: "Cobertura", short: "Cobertura" },
  { id: "imagenes", label: "Imágenes", short: "Imágenes" },
  { id: "campo", label: "Levantamiento", short: "Campo" },
  { id: "reglas", label: "Árbol y reglas", short: "Reglas" },
  { id: "auditoria", label: "Auditoría", short: "Auditoría" },
  { id: "fuentes", label: "Fuentes", short: "Fuentes" }
];

const DECISIONS: CatalogDecision[] = [
  {
    id: "masglo-abrumadora",
    title: "Masglo · Abrumadora",
    subtitle: "Tono tradicional · variante canónica",
    status: "EXACTO",
    confidence: 100,
    reason: "Nombre, código de tono, línea y carta de color apuntan a la misma variante.",
    sourceLabel: "Carta de tonos almacenada",
    sourceDetail: "La evidencia ya vive junto al producto Masglo y conserva su origen.",
    destination: "Esmalte MASGLO → variante TRA-ABRUMADORA",
    fields: [
      { key: "linea", label: "Línea", source: "Tradicional", current: "Esmalte MASGLO", proposal: "Tradicional" },
      { key: "tono", label: "Tono comercial", source: "Abrumadora", current: "Abrumadora", proposal: "Abrumadora" },
      { key: "codigo", label: "Código externo", source: "TRA-ABRUMADORA", current: "TRA-ABRUMADORA", proposal: "Conservar" },
      { key: "familia", label: "Familia cromática", source: "Morado", current: "Por clasificar", proposal: "Morado" }
    ]
  },
  {
    id: "crocodile-proveedores",
    title: "Crocodile · Sujetador negro",
    subtitle: "Misma unidad vendible · dos abastecimientos",
    status: "PROBABLE_EXISTENTE",
    confidence: 91,
    reason: "Las filas 5 y 6 comparten marca y descripción; cambia el proveedor y solo una trae código externo.",
    sourceLabel: "Listado Bellaroshé · filas 5–6",
    sourceDetail: "MAY aporta SHEY-193; KELMAR PUNO registra la misma descripción sin código.",
    destination: "Una variante canónica → dos ofertas de proveedor",
    fields: [
      { key: "producto", label: "Producto", source: "SUJETADOR COCODRILO NEGRO", current: "Sujetador Cocodrilo Negro", proposal: "Mantener una entidad" },
      { key: "proveedor1", label: "Oferta MAY", source: "SHEY-193", current: "Sin vínculo", proposal: "Vincular a variante" },
      { key: "proveedor2", label: "Oferta KELMAR", source: "Sin código", current: "Sin vínculo", proposal: "Vincular sin SKU" },
      { key: "alias", label: "Alias de proveedor", source: "SUJETADOR COCODRILO NEGRO", current: "—", proposal: "Conservar como alias" }
    ]
  },
  {
    id: "dnails-box24",
    title: "D'Nails · Box 24 tonos",
    subtitle: "¿Colección, set vendible o 24 variantes?",
    status: "CONFLICTO",
    confidence: 64,
    reason: "El nombre declara una caja, pero no identifica los 24 tonos ni prueba que se vendan por separado.",
    sourceLabel: "Listado Bellaroshé",
    sourceDetail: "Hay presentación 12 ml y color textual, pero falta la carta o el contenido exacto del box.",
    destination: "Detenido antes del catálogo canónico",
    fields: [
      { key: "tipo", label: "Tipo de entidad", source: "ESMALTE GEL BOX24 TONOS", current: "Producto simple", proposal: "Requiere decidir set vs. línea" },
      { key: "presentacion", label: "Presentación", source: "12 ML", current: "12 ml", proposal: "Conservar" },
      { key: "variantes", label: "Variantes", source: "24 declaradas", current: "1", proposal: "No crear sin lista" },
      { key: "imagenes", label: "Imágenes", source: "Imagen genérica", current: "Sin medio", proposal: "No asociar a tonos" }
    ]
  },
  {
    id: "fila-477",
    title: "Registro sin descripción",
    subtitle: "Fila original 477 · identidad insuficiente",
    status: "INSUFICIENTE",
    confidence: null,
    reason: "No hay descripción que permita saber qué producto representa la fila.",
    sourceLabel: "Listado Bellaroshé · fila 477",
    sourceDetail: "Es una de las seis filas originalmente marcadas para revisión manual.",
    destination: "REQUIERE_LEVANTAMIENTO_FISICO",
    fields: [
      { key: "frontal", label: "Foto frontal", source: "Falta", current: "—", proposal: "Solicitar" },
      { key: "posterior", label: "Foto posterior", source: "Falta", current: "—", proposal: "Solicitar" },
      { key: "barcode", label: "Código de barras", source: "Falta", current: "—", proposal: "Solicitar" },
      { key: "medidas", label: "Contenido o medidas", source: "Falta", current: "—", proposal: "Solicitar" }
    ]
  },
  {
    id: "admiss-coleccion",
    title: "Admiss · Esmalte tradicional",
    subtitle: "Colección cargada · cobertura visual incompleta",
    status: "EXACTO",
    confidence: 100,
    reason: "Las 75 variantes están conciliadas; la deuda está en evidencia e imágenes, no en identidad.",
    sourceLabel: "Auditoría del catálogo real",
    sourceDetail: "75 tonos cargados, 0 con foto verificada y 75 pendientes de imagen.",
    destination: "Cola IMAGEN_PENDIENTE agrupada por colección",
    fields: [
      { key: "producto", label: "Producto canónico", source: "Esmalte ADMISS", current: "Esmalte ADMISS", proposal: "Sin cambio" },
      { key: "tonos", label: "Tonos", source: "75", current: "75", proposal: "Cobertura cerrada" },
      { key: "media", label: "Imágenes verificadas", source: "0", current: "0", proposal: "Crear campaña de evidencia" },
      { key: "publicacion", label: "Publicación", source: "Sin foto", current: "Fallback editorial", proposal: "Mantener sin inventar" }
    ]
  }
];

const IMAGE_CANDIDATES = [
  {
    id: "img-abrumadora",
    title: "Abrumadora · Masglo",
    subtitle: "Envase + swatch de tono",
    confidence: 99,
    signal: "Marca + código + tono + línea",
    source: "Carta de color almacenada",
    swatch: "#6f325d",
    recommendation: "Puede aprobarse"
  },
  {
    id: "img-admiss-family",
    title: "Esmalte ADMISS",
    subtitle: "Fotografía de familia, sin código de tono",
    confidence: 58,
    signal: "Marca + empaque; falta variante",
    source: "Fuente comercial de contraste",
    swatch: "#d7a0b7",
    recommendation: "No asignar a tonos"
  },
  {
    id: "img-oem-lamp",
    title: "Lámpara de mesa sin marca",
    subtitle: "Empaque similar en varios proveedores",
    confidence: 31,
    signal: "Solo similitud visual",
    source: "Sin fuente autoritativa",
    swatch: "#d8d2ce",
    recommendation: "Fotografía propia"
  }
] as const;

const FIELD_CHECKLIST = [
  "Frente del envase",
  "Posterior y laterales",
  "Base, tapa y caja",
  "Código de barras y SKU",
  "Volumen, medidas o potencia",
  "Lote y etiquetas técnicas",
  "Accesorios incluidos",
  "Variantes o colores disponibles"
];

const BRAND_COVERAGE = [
  { brand: "Masglo", line: "Esmalte MASGLO", known: "164", loaded: "164", media: "157", pending: "7", state: "Colección conciliada" },
  { brand: "Admiss", line: "Esmalte ADMISS", known: "75", loaded: "75", media: "0", pending: "75", state: "Falta cobertura visual" },
  { brand: "Mystyle", line: "Líneas gel", known: "Por investigar", loaded: "23 referencias", media: "—", pending: "Abierto", state: "Universo externo pendiente" },
  { brand: "Cherimoya", line: "Gel, bases y tops", known: "Por investigar", loaded: "51 referencias", media: "—", pending: "Abierto", state: "Inventario por línea pendiente" }
];

const STATUS_LABEL: Record<DecisionStatus, string> = {
  EXACTO: "Exacto",
  PROBABLE_EXISTENTE: "Probable existente",
  CONFLICTO: "Conflicto",
  INSUFICIENTE: "Insuficiente"
};

function Icon({ name }: { name: "pulse" | "merge" | "coverage" | "image" | "camera" | "tree" | "audit" | "source" | "arrow" | "check" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    pulse: <><path d="M3 12h4l2.2-5 4.1 10 2.1-5H21" /></>,
    merge: <><path d="M5 5h4c4 0 4 5 8 5h2" /><path d="m16 7 3 3-3 3" /><path d="M5 19h4c3 0 4-3 6-5" /></>,
    coverage: <><rect x="4" y="4" width="6" height="6" /><rect x="14" y="4" width="6" height="6" /><rect x="4" y="14" width="6" height="6" /><path d="M14 17h6M17 14v6" /></>,
    image: <><rect x="3" y="4" width="18" height="16" /><path d="m3 16 5-5 4 4 3-3 6 6" /><circle cx="16" cy="9" r="1.5" /></>,
    camera: <><path d="M4 8h4l2-3h4l2 3h4v11H4z" /><circle cx="12" cy="13" r="3" /></>,
    tree: <><circle cx="12" cy="5" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M12 7v5M6 16v-4h12v4" /></>,
    audit: <><path d="M6 3h12v18H6z" /><path d="m9 8 1.5 1.5L14 6M9 14h6M9 17h6" /></>,
    source: <><path d="M5 3h14v18H5z" /><path d="M8 7h8M8 11h8M8 15h5" /></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>
  };
  return <svg className="cm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{paths[name]}</svg>;
}

const SECTION_ICON: Record<SectionId, Parameters<typeof Icon>[0]["name"]> = {
  inicio: "pulse",
  reconciliar: "merge",
  cobertura: "coverage",
  imagenes: "image",
  campo: "camera",
  reglas: "tree",
  auditoria: "audit",
  fuentes: "source"
};

function Status({ status }: { status: DecisionStatus }) {
  return <span className={`cm-status cm-status--${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

function Meter({ value, tone = "rose" }: { value: number; tone?: "rose" | "green" | "gold" }) {
  return <span className="cm-meter" aria-label={`${value}%`}><span className={`cm-meter-fill cm-meter-fill--${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>;
}

export function CatalogIntelligenceView() {
  const [section, setSection] = useState<SectionId>("inicio");
  const [decisionId, setDecisionId] = useState(DECISIONS[0].id);
  const [decisionFilter, setDecisionFilter] = useState<"TODOS" | DecisionStatus>("TODOS");
  const [selectedFields, setSelectedFields] = useState<Set<string>>(() => new Set(DECISIONS[0].fields.map((field) => field.key)));
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [imageDecisions, setImageDecisions] = useState<Record<string, ImageDecision>>({});
  const [fieldChecks, setFieldChecks] = useState<Set<string>>(new Set());
  const [activeSystem, setActiveSystem] = useState<"acrilico" | "soft-gel">("acrilico");
  const [sourceMode, setSourceMode] = useState<SourceMode>("resumen");

  const decision = DECISIONS.find((item) => item.id === decisionId) ?? DECISIONS[0];
  const visibleDecisions = useMemo(
    () => DECISIONS.filter((item) => decisionFilter === "TODOS" || item.status === decisionFilter),
    [decisionFilter]
  );

  function go(next: SectionId) {
    setSection(next);
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openDecision(id: string) {
    const next = DECISIONS.find((item) => item.id === id) ?? DECISIONS[0];
    setDecisionId(next.id);
    setSelectedFields(new Set(next.fields.map((field) => field.key)));
    setNotice("");
  }

  function toggleField(key: string) {
    setSelectedFields((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function resolveDecision(action: "apply" | "hold" | "field") {
    if (action === "apply") {
      setResolved((current) => new Set(current).add(decision.id));
      setNotice(`${selectedFields.size} campos quedaron registrados como decisión del prototipo. No se escribió en producción.`);
    } else if (action === "field") {
      setNotice("El caso pasó a la sesión de levantamiento con el checklist necesario.");
      setSection("campo");
    } else {
      setNotice("La propuesta quedó detenida. Ningún dato incierto avanzará al catálogo canónico.");
    }
  }

  function setImageDecision(id: string, value: ImageDecision) {
    setImageDecisions((current) => ({ ...current, [id]: value }));
    setNotice(value === "approved" ? "Imagen aprobada en el prototipo con su evidencia intacta." : "Imagen retenida: no se publicará ni se asignará automáticamente.");
  }

  function renderHome() {
    return (
      <>
        <section className="cm-kpis" aria-label="Indicadores principales">
          <article className="cm-kpi cm-kpi--hero">
            <span>Conciliación de la fuente inicial</span>
            <strong>100%</strong>
            <Meter value={100} tone="green" />
            <small>1,500 de 1,500 filas con destino explícito</small>
          </article>
          <article className="cm-kpi"><span>Productos canónicos</span><strong>1,056</strong><small>Una entidad reutilizable, no dos catálogos</small></article>
          <article className="cm-kpi"><span>Variantes</span><strong>1,578</strong><small>253 tienen tono estructurado</small></article>
          <article className="cm-kpi"><span>Evidencia visual en tonos</span><strong>62.5%</strong><Meter value={62.5} /><small>158 con foto o swatch · 95 pendientes</small></article>
        </section>

        <div className="cm-dashboard-grid">
          <section className="cm-panel cm-panel--priority">
            <header className="cm-panel-head">
              <div><span className="cm-eyebrow">Siguiente mejor trabajo</span><h2>Resolver deuda, no volver a importar</h2></div>
              <button className="cm-text-button" type="button" onClick={() => go("reconciliar")}>Abrir mesa <Icon name="arrow" /></button>
            </header>
            <div className="cm-priority-list">
              <button type="button" onClick={() => go("cobertura")}>
                <span className="cm-priority-number">93</span><span><b>Tonos aún en “Por clasificar”</b><small>Completar familia cromática con evidencia, no por intuición.</small></span><Icon name="arrow" />
              </button>
              <button type="button" onClick={() => go("imagenes")}>
                <span className="cm-priority-number">95</span><span><b>Tonos con imagen pendiente</b><small>75 pertenecen a Admiss; Masglo tiene 7 pendientes.</small></span><Icon name="arrow" />
              </button>
              <button type="button" onClick={() => go("auditoria")}>
                <span className="cm-priority-number">2</span><span><b>Registros demo fuera del alcance</b><small>Separar la deuda preexistente del cierre real de 1,500 filas.</small></span><Icon name="arrow" />
              </button>
            </div>
          </section>

          <aside className="cm-panel cm-panel--compact">
            <span className="cm-eyebrow">Estado de hoy</span>
            <h2>Catálogo estable, cobertura abierta</h2>
            <div className="cm-health-ring"><span>0</span><small>pendientes de la<br />conciliación inicial</small></div>
            <dl className="cm-mini-facts">
              <div><dt>Marcas en base</dt><dd>185</dd></div>
              <div><dt>Proveedores</dt><dd>69</dd></div>
              <div><dt>Categorías</dt><dd>64</dd></div>
            </dl>
          </aside>
        </div>

        <section className="cm-panel">
          <header className="cm-panel-head">
            <div><span className="cm-eyebrow">Sistema permanente</span><h2>El catálogo entra por evidencia y sale por gates</h2></div>
          </header>
          <div className="cm-lifecycle" aria-label="Ciclo permanente del catálogo">
            {[
              ["01", "Descubrir", "Marcas, líneas y fuentes"],
              ["02", "Normalizar", "Identidad y atributos"],
              ["03", "Reconciliar", "Exacto, nuevo o conflicto"],
              ["04", "Validar", "Evidencia y confianza"],
              ["05", "Publicar", "Solo lo que supera gates"],
              ["06", "Vigilar", "Cambios, huecos y nuevas líneas"]
            ].map(([number, title, copy], index) => (
              <div className="cm-life-step" key={number}>
                <span>{number}</span><b>{title}</b><small>{copy}</small>{index < 5 ? <i>→</i> : null}
              </div>
            ))}
          </div>
        </section>

        <section className="cm-impact">
          <div className="cm-impact-copy">
            <span className="cm-eyebrow">Impacto en el V3 público</span>
            <h2>La tienda deja de navegar por categorías administrativas</h2>
            <p>La misma estructura que reconcilia producto, sistema, función y etapa alimenta búsqueda, mega menús, recomendaciones y procesos guiados. El prototipo público ya no necesita inventar el orden a mano.</p>
            <button type="button" className="cm-secondary" onClick={() => go("reglas")}>Ver árbol y reglas</button>
          </div>
          <div className="cm-impact-flow" aria-label="De la base maestra a la experiencia pública">
            <div><span>Base maestra</span><b>Sistema · función · etapa · compatibilidad</b></div>
            <Icon name="arrow" />
            <div><span>Experiencia pública</span><b>Intención → proceso → producto → complemento</b></div>
          </div>
        </section>
      </>
    );
  }

  function renderReconcile() {
    const filters: Array<"TODOS" | DecisionStatus> = ["TODOS", "EXACTO", "PROBABLE_EXISTENTE", "CONFLICTO", "INSUFICIENTE"];
    return (
      <>
        <header className="cm-section-head">
          <div><span className="cm-eyebrow">Mesa de decisiones</span><h1>Reconciliar antes de tocar el catálogo</h1><p>Cinco casos reales de muestra. Cada propuesta conserva fuente, señales, confianza y destino.</p></div>
          <div className="cm-section-stat"><strong>{DECISIONS.length - resolved.size}</strong><span>casos de muestra<br />sin decisión local</span></div>
        </header>

        <div className="cm-filter-row" role="group" aria-label="Filtrar decisiones">
          {filters.map((filter) => (
            <button key={filter} type="button" className={filter === decisionFilter ? "is-active" : ""} onClick={() => setDecisionFilter(filter)}>
              {filter === "TODOS" ? "Todos" : STATUS_LABEL[filter]}
            </button>
          ))}
        </div>

        <div className="cm-workbench">
          <aside className="cm-queue" aria-label="Cola de reconciliación">
            {visibleDecisions.map((item) => (
              <button key={item.id} type="button" className={`${item.id === decision.id ? "is-active" : ""} ${resolved.has(item.id) ? "is-resolved" : ""}`} onClick={() => openDecision(item.id)}>
                <span className="cm-queue-top"><Status status={item.status} />{resolved.has(item.id) ? <i><Icon name="check" /> decidido</i> : null}</span>
                <b>{item.title}</b><small>{item.subtitle}</small>
                <span className="cm-queue-confidence">{item.confidence === null ? "Sin puntuar" : `${item.confidence}% de confianza`}</span>
              </button>
            ))}
            {!visibleDecisions.length ? <div className="cm-empty">No hay casos de muestra con este estado.</div> : null}
          </aside>

          <section className="cm-decision">
            <div className="cm-decision-head">
              <div><Status status={decision.status} /><h2>{decision.title}</h2><p>{decision.reason}</p></div>
              <div className="cm-confidence"><strong>{decision.confidence === null ? "—" : `${decision.confidence}%`}</strong><span>confianza</span></div>
            </div>

            <div className="cm-route-note"><span>Destino propuesto</span><b>{decision.destination}</b></div>

            <div className="cm-evidence-grid">
              <div><span>Fuente</span><b>{decision.sourceLabel}</b><small>{decision.sourceDetail}</small></div>
              <div><span>Política aplicada</span><b>{decision.status === "EXACTO" ? "Puede automatizarse" : "Debe detenerse para revisión"}</b><small>Ningún dato incierto se presenta como confirmado.</small></div>
            </div>

            <div className="cm-compare-head"><div><span className="cm-eyebrow">Comparación campo a campo</span><h3>Qué cambia y por qué</h3></div><span>{selectedFields.size} de {decision.fields.length} seleccionados</span></div>
            <div className="cm-compare-table" role="table" aria-label="Comparación de datos">
              <div className="cm-compare-row cm-compare-row--head" role="row"><span></span><span>Campo</span><span>Evidencia</span><span>Actual</span><span>Propuesta</span></div>
              {decision.fields.map((field) => (
                <label className="cm-compare-row" role="row" key={field.key}>
                  <span><input type="checkbox" checked={selectedFields.has(field.key)} onChange={() => toggleField(field.key)} /></span>
                  <b>{field.label}</b><span>{field.source}</span><span>{field.current}</span><strong>{field.proposal}</strong>
                </label>
              ))}
            </div>

            {notice ? <div className="cm-notice" role="status">{notice}</div> : null}
            <div className="cm-decision-actions">
              <button type="button" className="cm-primary" disabled={!selectedFields.size || decision.status === "CONFLICTO" || decision.status === "INSUFICIENTE"} onClick={() => resolveDecision("apply")}>Aplicar campos seguros</button>
              <button type="button" className="cm-secondary" onClick={() => resolveDecision("hold")}>Mantener en revisión</button>
              <button type="button" className="cm-text-button" onClick={() => resolveDecision("field")}>Pedir levantamiento físico</button>
            </div>
          </section>
        </div>
      </>
    );
  }

  function renderCoverage() {
    return (
      <>
        <header className="cm-section-head">
          <div><span className="cm-eyebrow">Cobertura verificable</span><h1>Una marca no está “lista” hasta cerrar sus líneas</h1><p>El sistema distingue lo conocido, lo cargado, lo que tiene evidencia y lo que aún debe investigarse.</p></div>
          <div className="cm-section-stat"><strong>185</strong><span>marcas detectadas<br />en la base actual</span></div>
        </header>

        <section className="cm-panel cm-coverage-summary">
          <div><span>Filas fuente</span><strong>1,500 / 1,500</strong><Meter value={100} tone="green" /><small>Conciliación cerrada</small></div>
          <div><span>Tonos estructurados</span><strong>253</strong><Meter value={100} tone="green" /><small>93 requieren familia cromática</small></div>
          <div><span>Tonos con evidencia visual</span><strong>158 / 253</strong><Meter value={62.5} /><small>150 fotos + 8 swatches</small></div>
          <div><span>Investigación externa</span><strong>En curso</strong><Meter value={12} tone="gold" /><small>No se infiere un total falso</small></div>
        </section>

        <section className="cm-panel">
          <header className="cm-panel-head"><div><span className="cm-eyebrow">Cobertura por línea</span><h2>Conocido vs. cargado</h2></div><span className="cm-data-note">Corte certificado: 09 ago 2026</span></header>
          <div className="cm-table-wrap">
            <table className="cm-table">
              <thead><tr><th>Marca</th><th>Línea</th><th>Conocido</th><th>Cargado</th><th>Con imagen</th><th>Pendiente</th><th>Estado</th></tr></thead>
              <tbody>{BRAND_COVERAGE.map((row) => (
                <tr key={`${row.brand}-${row.line}`}><td><b>{row.brand}</b></td><td>{row.line}</td><td>{row.known}</td><td>{row.loaded}</td><td>{row.media}</td><td>{row.pending}</td><td><span className={row.pending === "7" ? "cm-state cm-state--warn" : row.pending === "75" ? "cm-state cm-state--risk" : "cm-state"}>{row.state}</span></td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>

        <div className="cm-two-col">
          <section className="cm-panel">
            <span className="cm-eyebrow">Caso completo</span><h2>Masglo · tradicional</h2>
            <div className="cm-collection-score"><strong>164</strong><span>tonos conocidos y cargados</span></div>
            <dl className="cm-list-facts"><div><dt>Con fotografía</dt><dd>157</dd></div><div><dt>Imagen pendiente</dt><dd>7</dd></div><div><dt>Duplicados de shade</dt><dd>0</dd></div><div><dt>Incoherencias marca/tono</dt><dd>0</dd></div></dl>
            <button type="button" className="cm-secondary" onClick={() => { openDecision("masglo-abrumadora"); go("reconciliar"); }}>Ver decisión Abrumadora</button>
          </section>
          <section className="cm-panel cm-panel--tint">
            <span className="cm-eyebrow">Regla de honestidad</span><h2>“Por investigar” es un dato válido</h2>
            <p>Cuando aún no se ha reconstruido el universo oficial de una marca, el tablero no inventa un denominador ni muestra un porcentaje tranquilizador. Abre una tarea de investigación con fuente y fecha.</p>
            <div className="cm-callout"><b>Próximo bloque sugerido</b><span>Admiss: jerarquía oficial → líneas → 75 tonos → imágenes → estado comercial.</span></div>
          </section>
        </div>
      </>
    );
  }

  function renderImages() {
    const approved = Object.values(imageDecisions).filter((value) => value === "approved").length;
    const held = Object.values(imageDecisions).filter((value) => value === "held").length;
    return (
      <>
        <header className="cm-section-head">
          <div><span className="cm-eyebrow">Pipeline conservador</span><h1>Muchas imágenes sirven; una imagen equivocada no</h1><p>Cada archivo conserva procedencia, señales de asociación, checksum, confianza y decisión humana.</p></div>
          <div className="cm-section-stat"><strong>95</strong><span>tonos clasificados<br />como imagen pendiente</span></div>
        </header>

        <section className="cm-image-pipeline">
          {["Descubrir", "Descargar", "Normalizar", "Verificar", "Deduplicar", "Asociar", "Aprobar", "Publicar"].map((step, index) => <div key={step}><span>{String(index + 1).padStart(2, "0")}</span><b>{step}</b></div>)}
        </section>

        <div className="cm-image-summary">
          <div><strong>150</strong><span>tonos con foto</span></div><div><strong>8</strong><span>con swatch</span></div><div><strong>95</strong><span>pendientes</span></div><div><strong>{approved}</strong><span>aprobadas ahora</span></div><div><strong>{held}</strong><span>retenidas ahora</span></div>
        </div>

        <section className="cm-panel">
          <header className="cm-panel-head"><div><span className="cm-eyebrow">Bandeja de verificación</span><h2>Candidatas con evidencia visible</h2></div><span className="cm-data-note">Casos de interacción del prototipo</span></header>
          <div className="cm-image-grid">
            {IMAGE_CANDIDATES.map((candidate) => {
              const decisionValue = imageDecisions[candidate.id] ?? "pending";
              return (
                <article className={`cm-image-card cm-image-card--${decisionValue}`} key={candidate.id}>
                  <div className="cm-image-preview" style={{ "--swatch": candidate.swatch } as React.CSSProperties}>
                    <span className="cm-bottle"><i></i></span><span className="cm-swatch"></span>
                    {decisionValue !== "pending" ? <b>{decisionValue === "approved" ? "Aprobada" : "Retenida"}</b> : null}
                  </div>
                  <div className="cm-image-body"><span className="cm-eyebrow">{candidate.subtitle}</span><h3>{candidate.title}</h3>
                    <dl><div><dt>Confianza</dt><dd>{candidate.confidence}%</dd></div><div><dt>Señales</dt><dd>{candidate.signal}</dd></div><div><dt>Fuente</dt><dd>{candidate.source}</dd></div></dl>
                    <div className="cm-image-recommendation">{candidate.recommendation}</div>
                    <div className="cm-image-actions"><button type="button" className="cm-primary" disabled={candidate.confidence < 90} onClick={() => setImageDecision(candidate.id, "approved")}>Aprobar asociación</button><button type="button" className="cm-secondary" onClick={() => setImageDecision(candidate.id, "held")}>Retener</button></div>
                  </div>
                </article>
              );
            })}
          </div>
          {notice ? <div className="cm-notice" role="status">{notice}</div> : null}
        </section>

        <section className="cm-policy-strip"><div><b>Automático</b><span>EAN/SKU/código oficial + variante exacta</span></div><div><b>Revisión</b><span>Nombre y empaque sin código inequívoco</span></div><div><b>Nunca automático</b><span>Solo similitud visual o imagen de familia</span></div></section>
      </>
    );
  }

  function renderField() {
    const completed = fieldChecks.size;
    return (
      <>
        <header className="cm-section-head">
          <div><span className="cm-eyebrow">REQUIERE_LEVANTAMIENTO_FISICO</span><h1>Una sesión clara para quien está en tienda</h1><p>El operador recibe tomas concretas y productos agrupados; no necesita entender el modelo de datos.</p></div>
          <div className="cm-section-stat"><strong>{completed}/{FIELD_CHECKLIST.length}</strong><span>tomas marcadas<br />en el caso activo</span></div>
        </header>

        <div className="cm-field-layout">
          <section className="cm-panel cm-field-groups">
            <span className="cm-eyebrow">Plan propuesto</span><h2>Sesión 01 · productos sin identidad suficiente</h2>
            <button type="button" className="is-active"><span className="cm-field-index">A</span><span><b>Registro sin descripción</b><small>Fila 477 · prioridad crítica</small></span><strong>8 tomas</strong></button>
            <button type="button"><span className="cm-field-index">B</span><span><b>Lámparas y equipos OEM</b><small>Agrupar por ubicación de almacén</small></span><strong>6 productos</strong></button>
            <button type="button"><span className="cm-field-index">C</span><span><b>Boxes y colecciones cerradas</b><small>{"D'Nails, Mystyle y empaques múltiples"}</small></span><strong>4 productos</strong></button>
            <div className="cm-field-route"><span>Orden sugerido</span><b>Almacén → vitrina uñas → equipos</b><small>Menos traslados; productos relacionados permanecen juntos.</small></div>
          </section>

          <section className="cm-panel cm-checklist-panel">
            <header><div><span className="cm-eyebrow">Caso activo</span><h2>Registro sin descripción · fila 477</h2></div><span className="cm-progress-number">{Math.round((completed / FIELD_CHECKLIST.length) * 100)}%</span></header>
            <Meter value={(completed / FIELD_CHECKLIST.length) * 100} tone="green" />
            <div className="cm-checklist">
              {FIELD_CHECKLIST.map((item) => (
                <label key={item} className={fieldChecks.has(item) ? "is-done" : ""}><input type="checkbox" checked={fieldChecks.has(item)} onChange={() => setFieldChecks((current) => { const next = new Set(current); if (next.has(item)) next.delete(item); else next.add(item); return next; })} /><span><Icon name="check" /></span><b>{item}</b></label>
              ))}
            </div>
            <div className="cm-checklist-footer"><span>Al completar, el caso vuelve a Reconciliar con nueva evidencia.</span><button type="button" className="cm-primary" disabled={completed < FIELD_CHECKLIST.length} onClick={() => { setNotice("Levantamiento completo en el prototipo; el caso está listo para una nueva reconciliación."); openDecision("fila-477"); go("reconciliar"); }}>Cerrar levantamiento</button></div>
          </section>
        </div>
      </>
    );
  }

  function renderRules() {
    const acrylic = activeSystem === "acrilico";
    const steps = acrylic ? ["Preparar", "Extender", "Construir", "Dar forma", "Decorar", "Sellar"] : ["Preparar", "Elegir tip", "Adherir", "Curar", "Dar forma", "Sellar"];
    return (
      <>
        <header className="cm-section-head">
          <div><span className="cm-eyebrow">Árbol natural del negocio</span><h1>Procesos primero; productos en el momento correcto</h1><p>Un accesorio no vive en una bolsa genérica: participa en una etapa, una función y un sistema.</p></div>
          <div className="cm-section-stat"><strong>51</strong><span>familias iniciales<br />que deben ganar contexto</span></div>
        </header>

        <div className="cm-system-switch" role="tablist" aria-label="Sistema de uñas">
          <button type="button" role="tab" aria-selected={acrylic} className={acrylic ? "is-active" : ""} onClick={() => setActiveSystem("acrilico")}>Sistema acrílico</button>
          <button type="button" role="tab" aria-selected={!acrylic} className={!acrylic ? "is-active" : ""} onClick={() => setActiveSystem("soft-gel")}>Soft Gel</button>
        </div>

        <section className="cm-process-panel">
          <div className="cm-process-breadcrumb"><span>Uñas</span><i>→</i><span>{acrylic ? "Construir / extender" : "Extender"}</span><i>→</i><b>{acrylic ? "Acrílico" : "Soft Gel"}</b></div>
          <div className="cm-process-steps">{steps.map((step, index) => <div key={step} className={index === 2 ? "is-current" : ""}><span>{String(index + 1).padStart(2, "0")}</span><b>{step}</b></div>)}</div>
          <div className="cm-process-context">
            <div><span className="cm-eyebrow">Etapa activa</span><h2>{steps[2]}</h2><p>{acrylic ? "Polvo acrílico y monómero aparecen juntos porque cumplen la función de construcción. El pincel entra como necesario; la lámpara UV no." : "El adhesivo y la lámpara compatible aparecen aquí. El tip seleccionado restringe alternativas incompatibles."}</p></div>
            <div className="cm-rule-list">
              {(acrylic ? [
                ["Requiere", "Monómero compatible"], ["Necesario", "Pincel para acrílico"], ["Paso siguiente", "Lima / drill para dar forma"], ["Alternativa", "Otro polvo del mismo sistema"]
              ] : [
                ["Requiere", "Adhesivo para Soft Gel"], ["Requiere", "Lámpara UV/LED"], ["Compatible", "Tip según forma y talla"], ["Paso siguiente", "Top compatible"]
              ]).map(([relation, target]) => <div key={`${relation}-${target}`}><span>{relation}</span><b>{target}</b></div>)}
            </div>
          </div>
        </section>

        <div className="cm-two-col">
          <section className="cm-panel"><span className="cm-eyebrow">Reglas, no millones de enlaces</span><h2>Compatibilidad derivada</h2><p>Si una base declara compatibilidad con <code>SISTEMA_GEL_UV</code>, la tienda puede encontrar todos los esmaltes compatibles sin crear una relación manual por pareja.</p><div className="cm-code-rule"><span>SI</span><b>sistema = GEL_UV</b><span>Y</span><b>etapa = COLOR</b><span>→</span><b>mostrar base/top compatibles</b></div></section>
          <section className="cm-panel cm-panel--tint"><span className="cm-eyebrow">Texto que cambia en el V3</span><h2>La guía acompaña; no obliga</h2><ul className="cm-copy-list"><li><s>“Siguiente paso obligatorio”</s><b>“Ir a Construir” o “Ya lo tengo”</b></li><li><s>“También te puede gustar”</s><b>“Necesario para este paso”</b></li><li><s>“Accesorios”</s><b>“Dar forma · limas, drill y brocas”</b></li></ul></section>
        </div>
      </>
    );
  }

  function renderAudit() {
    const gates = [
      ["Conciliación de la fuente", "1,500 = 1,492 importadas + 3 duplicadas + 5 excluidas", "pass"],
      ["Duplicados canónicos", "0 SKU, códigos internos u ofertas idénticas duplicadas", "pass"],
      ["Integridad producto/variante", "0 productos huérfanos y 0 variantes sin producto", "pass"],
      ["Coherencia de tonos", "0 incoherencias marca/shade y 0 shades duplicados", "pass"],
      ["Cobertura cromática", "93 tonos permanecen explícitamente Por clasificar", "warn"],
      ["Cobertura de imágenes", "95 tonos permanecen en IMAGEN_PENDIENTE", "warn"],
      ["Universo externo por marca", "Todavía no tiene denominador completo verificable", "open"]
    ];
    return (
      <>
        <header className="cm-section-head">
          <div><span className="cm-eyebrow">Gates de calidad</span><h1>El script termina; la evidencia decide</h1><p>El cierre separa la conciliación ya certificada de la investigación y el enriquecimiento que siguen abiertos.</p></div>
          <div className="cm-section-stat cm-section-stat--ok"><strong>0</strong><span>pendientes en la<br />ecuación de 1,500 filas</span></div>
        </header>

        <section className="cm-reconciliation-equation">
          <div><span>Fuente</span><strong>1,500</strong></div><i>=</i><div><span>Importadas</span><strong>1,492</strong></div><i>+</i><div><span>Duplicadas</span><strong>3</strong></div><i>+</i><div><span>Excluidas</span><strong>5</strong></div><i>+</i><div><span>Pendientes</span><strong>0</strong></div>
        </section>

        <section className="cm-panel">
          <header className="cm-panel-head"><div><span className="cm-eyebrow">Certificación por condición</span><h2>Qué puede demostrarse hoy</h2></div><span className="cm-data-note">Fuente: auditoría 2026-08-09</span></header>
          <div className="cm-gates">{gates.map(([title, detail, state]) => <div key={title} className={`cm-gate cm-gate--${state}`}><span>{state === "pass" ? <Icon name="check" /> : state === "warn" ? "!" : "○"}</span><div><b>{title}</b><small>{detail}</small></div><strong>{state === "pass" ? "Superado" : state === "warn" ? "Deuda visible" : "Por investigar"}</strong></div>)}</div>
        </section>

        <section className="cm-panel">
          <header className="cm-panel-head"><div><span className="cm-eyebrow">Entregables permanentes</span><h2>El sistema debe producirlos en cada ciclo</h2></div></header>
          <div className="cm-deliverables">{[
            ["A", "Árbol maestro", "Familias, sistemas, procesos y etapas"], ["B", "Taxonomía canónica", "Tipo, función, atributos y compatibilidad"], ["C", "Catálogo reconciliado", "Creado, corregido, reutilizado o detenido"], ["D", "Cobertura por marca", "Conocido vs. cargado con fuente"], ["E", "Cobertura de colecciones", "Tonos y variantes sistemáticas"], ["F", "No identificados", "Motivo y acción exacta"], ["G", "Checklist fotográfico", "Tomas agrupadas por sesión"], ["H", "Inventario de imágenes", "Fuente, checksum, confianza y estado"], ["I", "Relaciones", "Reglas y compatibilidades derivadas"], ["J", "Excepciones", "Nada dudoso desaparece"]
          ].map(([letter, title, detail]) => <div key={letter}><span>{letter}</span><b>{title}</b><small>{detail}</small></div>)}</div>
        </section>
      </>
    );
  }

  function renderSources() {
    if (sourceMode === "masiva") return <div className="cm-source-tool"><button type="button" className="cm-back" onClick={() => setSourceMode("resumen")}>← Volver a fuentes</button><CatalogBulkImportView /></div>;
    if (sourceMode === "plantilla") return <div className="cm-source-tool"><button type="button" className="cm-back" onClick={() => setSourceMode("resumen")}>← Volver a fuentes</button><CatalogImportView /></div>;
    return (
      <>
        <header className="cm-section-head">
          <div><span className="cm-eyebrow">Entradas al sistema</span><h1>El Excel es una fuente, no el producto</h1><p>Las cargas siguen disponibles para nuevos lotes, pero ya no dominan la experiencia ni escriben directamente al catálogo.</p></div>
          <div className="cm-section-stat"><strong>8</strong><span>etapas entre fuente<br />y publicación segura</span></div>
        </header>
        <section className="cm-source-map">
          {[
            ["FUENTES", "Excel, catálogos, web oficial, proveedor, tienda"], ["RAW", "Copia literal, checksum, fecha y procedencia"], ["NORMALIZADO", "Identidad, nombres, atributos y unidades"], ["STAGING", "Propuestas aisladas del catálogo final"], ["RECONCILIACIÓN", "Exacto, probable, nuevo, conflicto o insuficiente"], ["VALIDACIÓN", "Evidencia, confianza y revisión"], ["CANÓNICO", "Una entidad producto/variante"], ["PUBLICACIÓN", "Solo lo que supera gates"]
          ].map(([name, copy], index) => <div key={name}><span>{String(index + 1).padStart(2, "0")}</span><b>{name}</b><small>{copy}</small>{index < 7 ? <i>↓</i> : null}</div>)}
        </section>
        <div className="cm-source-options">
          <button type="button" onClick={() => setSourceMode("masiva")}><span className="cm-source-icon">XLSX</span><b>Listado real / lote masivo</b><small>Normaliza listados crudos y deja solo excepciones para decisión.</small><strong>Abrir herramienta →</strong></button>
          <button type="button" onClick={() => setSourceMode("plantilla")}><span className="cm-source-icon">V2</span><b>Plantilla curada</b><small>Para altas estructuradas cuando la línea y sus atributos ya están definidos.</small><strong>Abrir herramienta →</strong></button>
          <div><span className="cm-source-icon cm-source-icon--quiet">URL</span><b>Investigación externa</b><small>Próximo conector: fuente, captura, fecha, confianza y licencia de imagen.</small><strong>Diseñado · aún no conectado</strong></div>
        </div>
      </>
    );
  }

  function renderCurrent() {
    if (section === "inicio") return renderHome();
    if (section === "reconciliar") return renderReconcile();
    if (section === "cobertura") return renderCoverage();
    if (section === "imagenes") return renderImages();
    if (section === "campo") return renderField();
    if (section === "reglas") return renderRules();
    if (section === "auditoria") return renderAudit();
    return renderSources();
  }

  return (
    <div className="cm-page">
      <section className="cm-hero">
        <div>
          <span className="cm-kicker"><i></i> Prototipo operativo · datos locales · no escribe en producción</span>
          <h1>Base maestra de producto</h1>
          <p>Enriquecer, reconciliar y gobernar el catálogo Bellaroshé de forma continua.</p>
        </div>
        <button type="button" className="cm-cert" onClick={() => go("auditoria")}>
          <span><Icon name="audit" /></span><span><small>Último cierre certificado</small><b>1,500 / 1,500 filas</b><i>09 ago 2026</i></span><Icon name="arrow" />
        </button>
      </section>

      <nav className="cm-nav" role="tablist" aria-label="Áreas de la base maestra">
        {SECTIONS.map((item) => (
          <button type="button" role="tab" aria-selected={section === item.id} className={section === item.id ? "is-active" : ""} key={item.id} onClick={() => go(item.id)}>
            <Icon name={SECTION_ICON[item.id]} /><span className="cm-nav-full">{item.label}</span><span className="cm-nav-short">{item.short}</span>
          </button>
        ))}
      </nav>

      <main className="cm-content" key={section}>{renderCurrent()}</main>
    </div>
  );
}
