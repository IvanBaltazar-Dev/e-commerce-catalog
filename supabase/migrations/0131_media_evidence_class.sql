-- 0131 · Qué clase de medio es, y si eso basta para enseñarlo.
--
-- Los 55 visuales de MASGLO quedaron sin publicar por una compuerta que decía
-- «validar derechos y correspondencia» archivo por archivo. Eso convertía una
-- pregunta de procedencia —que es una, y de la fuente— en cincuenta y cinco
-- revisiones de producto.
--
-- La regla real es más simple y no relaja nada:
--
--   FOTO_REAL                fotografía del envase concreto        → publicar
--   VISUAL_ESTANDARIZADO     construido para ESE tono, asociado
--                            objetivamente a su variante           → publicar
--   SWATCH_REFERENCIAL       el color, no el envase                → publicar como respaldo
--   IMAGEN_DE_OTRO_TONO      relleno con la foto de otra variante  → PROHIBIDO
--
-- La prohibición que ya teníamos sigue intacta: no se rellena con la imagen de
-- otro tono. Pero un visual construido específicamente para «Tiza», asociado a
-- la variante «Tiza», no es la imagen de otra variante y no debe castigarse
-- como si lo fuera.
--
-- Y si hay una cuestión de derechos, se resuelve una vez a nivel de fuente o de
-- campaña. Nunca multiplicando revisión humana por producto.

begin;

create table public.catalog_media_evidence_classes (
  code text primary key,
  publishable boolean not null,
  is_fallback boolean not null default false,
  description text not null,
  sort_order integer not null default 0
);

insert into public.catalog_media_evidence_classes
  (code, publishable, is_fallback, description, sort_order) values
  ('FOTO_REAL', true, false,
   'Fotografía del envase concreto de esa variante.', 10),
  ('VISUAL_ESTANDARIZADO', true, false,
   'Visual construido para ese tono sobre envase de referencia, asociado objetivamente a su variante. No es una foto individual y no finge serlo.', 20),
  ('SWATCH_REFERENCIAL', true, true,
   'El color, no el envase. Sirve de respaldo cuando no hay imagen de producto.', 30),
  ('IMAGEN_DE_OTRO_TONO', false, false,
   'La imagen de otra variante usada como relleno. Prohibida: hace creer a la clienta que compra algo que no verá.', 90);

alter table public.media_assets
  add column evidence_class text references public.catalog_media_evidence_classes(code);

comment on column public.media_assets.evidence_class is
  'Qué clase de evidencia visual es. Decide si puede enseñarse, sin revisar producto por producto.';

-- Lo que la campaña ya sabe de cada medio se traduce a su clase. El manifiesto
-- auditado de MASGLO lo dice archivo por archivo; aquí deja de ser un dato
-- suelto y pasa a ser el criterio de publicación.
update public.media_assets
set evidence_class = case
  when metadata ->> 'evidenceStatus' = 'VISUAL_ESTANDARIZADO_NO_FOTO_INDIVIDUAL' then 'VISUAL_ESTANDARIZADO'
  when metadata ->> 'evidenceStatus' = 'FOTO_OFICIAL_ORIGINAL' then 'FOTO_REAL'
  when metadata ->> 'officialUrl' is not null then 'FOTO_REAL'
  else evidence_class
end
where evidence_class is null;

-- Los swatch declarados como tales por su rol.
update public.media_assets asset
set evidence_class = 'SWATCH_REFERENCIAL'
where asset.evidence_class is null
  and exists (
    select 1 from public.product_media link
    where link.media_asset_id = asset.id and link.media_role = 'swatch'
  );

-- Qué puede enseñarse hoy y por qué. La interfaz consulta esto, no reconstruye
-- la regla.
create or replace view public.catalog_media_publishable_v1
with (security_invoker = true) as
select
  link.variant_id,
  link.product_id,
  link.media_role,
  link.is_primary,
  asset.id as media_asset_id,
  asset.bucket,
  asset.storage_path,
  asset.evidence_class,
  class.is_fallback,
  class.description as evidence_description
from public.product_media link
join public.media_assets asset on asset.id = link.media_asset_id
join public.catalog_media_evidence_classes class on class.code = asset.evidence_class
where class.publishable;

alter table public.catalog_media_evidence_classes enable row level security;
create policy catalog_media_evidence_classes_read on public.catalog_media_evidence_classes
  for select to authenticated using (true);

grant select on public.catalog_media_publishable_v1 to authenticated, anon, service_role;

commit;
