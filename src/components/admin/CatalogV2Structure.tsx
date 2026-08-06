"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/admin/ToastProvider";
import { useApiError } from "@/components/admin/useApiError";
import { adminApi } from "@/lib/admin/api";
import type { AdminV2Bootstrap, AttributeDataType, AttributeScope } from "@/lib/admin/catalog-v2";

function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function CatalogV2Structure() {
  const showToast = useToast();
  const handleApiError = useApiError();
  const [data, setData] = useState<AdminV2Bootstrap | null>(null);
  const [saving, setSaving] = useState(false);
  const [category, setCategory] = useState({ name: "", slug: "", parentId: "", templateId: "" });
  const [template, setTemplate] = useState({ name: "", code: "", description: "" });
  const [attribute, setAttribute] = useState<{ name: string; code: string; dataType: AttributeDataType; scope: AttributeScope; unit: string; isRequired: boolean; isVariantAxis: boolean; isFilterable: boolean; options: string }>({ name: "", code: "", dataType: "text", scope: "product", unit: "", isRequired: false, isVariantAxis: false, isFilterable: false, options: "" });
  const [association, setAssociation] = useState({ templateId: "", attributeDefinitionId: "", scope: "product" as AttributeScope, isRequired: false });

  const load = useCallback(async () => {
    try { setData(await adminApi.catalogV2Bootstrap()); }
    catch (error) { handleApiError(error, "No se pudo cargar la estructura V2."); }
  }, [handleApiError]);
  useEffect(() => { load(); }, [load]);

  const parentPath = useMemo(() => data?.categories.find((item) => item.id === category.parentId)?.path ?? "", [data, category.parentId]);
  const previewPath = [parentPath, category.slug || slugify(category.name)].filter(Boolean).join("/");

  async function mutate(payload: Record<string, unknown>, success: string) {
    if (saving) return;
    setSaving(true);
    try {
      await adminApi.mutateCatalogV2Structure(payload);
      showToast(success);
      await load();
    } catch (error) { handleApiError(error, "No se pudo guardar la estructura."); }
    finally { setSaving(false); }
  }

  if (!data) return <div className="loading-block"><span className="spinner spinner--pink" /> Cargando estructura…</div>;

  return (
    <div className="form-page br-fade">
      <div className="form-head"><div><div className="form-title">Estructura del catálogo V2</div><div className="field-hint">Categorías jerárquicas, plantillas y atributos controlados.</div></div></div>

      <div className="form-card">
        <div className="form-title" style={{ fontSize: 18 }}>Nueva categoría</div>
        <div className="grid-fields form-section">
          <div><div className="field-label">Nombre</div><input className="input" value={category.name} onChange={(event) => setCategory((current) => ({ ...current, name: event.target.value, slug: current.slug || slugify(event.target.value) }))} /></div>
          <div><div className="field-label">Slug</div><input className="input" value={category.slug} onChange={(event) => setCategory((current) => ({ ...current, slug: slugify(event.target.value) }))} /></div>
          <div><div className="field-label">Categoría padre</div><select className="input" value={category.parentId} onChange={(event) => setCategory((current) => ({ ...current, parentId: event.target.value }))}><option value="">Raíz</option>{data.categories.map((item) => <option key={item.id} value={item.id}>{"· ".repeat(item.depth)}{item.path}</option>)}</select></div>
          <div><div className="field-label">Plantilla</div><select className="input" value={category.templateId} onChange={(event) => setCategory((current) => ({ ...current, templateId: event.target.value }))}><option value="">Heredar / sin plantilla</option>{data.templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        </div>
        <div className="carta-note">Ruta canónica prevista: <b>{previewPath || "—"}</b></div>
        <div className="form-actions"><button className="btn-save" type="button" disabled={saving || !category.name || !category.slug} onClick={() => mutate({ action: "create_category", name: category.name, slug: category.slug, parentId: category.parentId || null, templateId: category.templateId || null }, "Categoría creada ✓").then(() => setCategory({ name: "", slug: "", parentId: "", templateId: "" }))}>Crear categoría</button></div>
      </div>

      <div className="form-card">
        <div className="form-title" style={{ fontSize: 18 }}>Nueva plantilla</div>
        <div className="grid-fields form-section">
          <div><div className="field-label">Nombre</div><input className="input" value={template.name} onChange={(event) => setTemplate((current) => ({ ...current, name: event.target.value }))} /></div>
          <div><div className="field-label">Código estable</div><input className="input" value={template.code} placeholder="EQUIPOS_PRO" onChange={(event) => setTemplate((current) => ({ ...current, code: event.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, "_") }))} /></div>
        </div>
        <div className="form-section"><div className="field-label">Descripción</div><textarea className="input textarea" value={template.description} onChange={(event) => setTemplate((current) => ({ ...current, description: event.target.value }))} /></div>
        <div className="form-actions"><button className="btn-save" type="button" disabled={saving || !template.name || !template.code} onClick={() => mutate({ action: "create_template", ...template }, "Plantilla creada ✓").then(() => setTemplate({ name: "", code: "", description: "" }))}>Crear plantilla</button></div>
      </div>

      <div className="form-card">
        <div className="form-title" style={{ fontSize: 18 }}>Nuevo atributo</div>
        <div className="grid-fields form-section">
          <div><div className="field-label">Nombre visible</div><input className="input" value={attribute.name} onChange={(event) => setAttribute((current) => ({ ...current, name: event.target.value, code: current.code || slugify(event.target.value).replace(/-/g, "_") }))} /></div>
          <div><div className="field-label">Código estable</div><input className="input" value={attribute.code} onChange={(event) => setAttribute((current) => ({ ...current, code: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_") }))} /></div>
          <div><div className="field-label">Tipo</div><select className="input" value={attribute.dataType} onChange={(event) => setAttribute((current) => ({ ...current, dataType: event.target.value as AttributeDataType }))}>{["text", "integer", "decimal", "boolean", "date", "single_option", "multi_option", "color", "measurement", "json"].map((value) => <option key={value}>{value}</option>)}</select></div>
          <div><div className="field-label">Alcance</div><select className="input" value={attribute.scope} onChange={(event) => setAttribute((current) => ({ ...current, scope: event.target.value as AttributeScope }))}><option value="product">Producto</option><option value="variant">Variante</option><option value="both">Ambos</option></select></div>
          <div><div className="field-label">Unidad opcional</div><input className="input" value={attribute.unit} onChange={(event) => setAttribute((current) => ({ ...current, unit: event.target.value }))} /></div>
        </div>
        <div className="chip-row form-section">{[["Obligatorio", "isRequired"], ["Genera variantes", "isVariantAxis"], ["Filtrable", "isFilterable"]].map(([label, key]) => { const stateKey = key as "isRequired" | "isVariantAxis" | "isFilterable"; return <button key={key} type="button" className={attribute[stateKey] ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => setAttribute((current) => ({ ...current, [stateKey]: !current[stateKey] }))}>{label}</button>; })}</div>
        {(["single_option", "multi_option", "color"] as AttributeDataType[]).includes(attribute.dataType) ? <div className="form-section"><div className="field-label">Opciones, una por línea: valor=Etiqueta</div><textarea className="input textarea" value={attribute.options} placeholder={"almond=Almond\ncoffin=Coffin"} onChange={(event) => setAttribute((current) => ({ ...current, options: event.target.value }))} /></div> : null}
        <div className="form-actions"><button className="btn-save" type="button" disabled={saving || !attribute.name || !attribute.code} onClick={() => mutate({ action: "create_attribute", ...attribute, unit: attribute.unit || null, options: attribute.options.split(/\r?\n/).filter(Boolean).map((line) => { const [value, ...label] = line.split("="); return { value: value.trim(), label: (label.join("=") || value).trim() }; }) }, "Atributo creado ✓").then(() => setAttribute({ name: "", code: "", dataType: "text", scope: "product", unit: "", isRequired: false, isVariantAxis: false, isFilterable: false, options: "" }))}>Crear atributo</button></div>
      </div>

      <div className="form-card">
        <div className="form-title" style={{ fontSize: 18 }}>Asociar atributo a plantilla</div>
        <div className="grid-fields form-section">
          <div><div className="field-label">Plantilla</div><select className="input" value={association.templateId} onChange={(event) => setAssociation((current) => ({ ...current, templateId: event.target.value }))}><option value="">Seleccionar…</option>{data.templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
          <div><div className="field-label">Atributo</div><select className="input" value={association.attributeDefinitionId} onChange={(event) => { const definition = data.attributes.find((item) => item.id === event.target.value); setAssociation((current) => ({ ...current, attributeDefinitionId: event.target.value, scope: definition?.scope ?? "product", isRequired: definition?.isRequired ?? false })); }}><option value="">Seleccionar…</option>{data.attributes.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.scope}</option>)}</select></div>
          <div><div className="field-label">Alcance en plantilla</div><select className="input" value={association.scope} onChange={(event) => setAssociation((current) => ({ ...current, scope: event.target.value as AttributeScope }))}><option value="product">Producto</option><option value="variant">Variante</option><option value="both">Ambos</option></select></div>
        </div>
        <div className="chip-row form-section"><button type="button" className={association.isRequired ? "opt-chip opt-chip--active" : "opt-chip"} onClick={() => setAssociation((current) => ({ ...current, isRequired: !current.isRequired }))}>Obligatorio en esta plantilla</button></div>
        <div className="form-actions"><button className="btn-save" type="button" disabled={saving || !association.templateId || !association.attributeDefinitionId} onClick={() => mutate({ action: "attach_attribute", ...association, sortOrder: 100 }, "Atributo asociado ✓")}>Asociar atributo</button></div>
      </div>

      <div className="form-card"><div className="form-title" style={{ fontSize: 18 }}>Rutas actuales</div><div style={{ marginTop: 12 }}>{data.categories.map((item) => <div key={item.id} className="carta-note" style={{ marginTop: 6 }}><b>{item.path}</b> · {data.templates.find((templateItem) => templateItem.id === item.templateId)?.name ?? "sin plantilla directa"}</div>)}</div></div>
    </div>
  );
}
