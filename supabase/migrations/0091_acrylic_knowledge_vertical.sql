-- ---------------------------------------------------------------------------
-- 0091 · Vertical de conocimiento Acrílico
-- ---------------------------------------------------------------------------
-- Convierte la investigación de Acrílico en conocimiento aprobado y deuda
-- explícita. No crea compatibilidades entre marcas por coincidencia de nombre,
-- no confunde recipientes con monómeros y no usa el precio como requisito del
-- grafo. PostgreSQL continúa siendo la única fuente de verdad.

begin;

-- La incertidumbre también es dato. Esta cola evita que una ausencia de
-- evidencia termine convertida en una relación falsa o en una nota perdida.
create table public.catalog_knowledge_gaps (
  id uuid primary key default gen_random_uuid(),
  gap_key text not null unique,
  system_id uuid not null references public.catalog_systems(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  class_id uuid references public.catalog_classes(id) on delete cascade,
  gap_type text not null,
  priority text not null default 'medium',
  status text not null default 'open',
  title text not null,
  question text not null,
  resolution_requirement text not null,
  resolved_evidence_set_id uuid references public.catalog_evidence_sets(id) on delete restrict,
  decided_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_knowledge_gaps_key_format check (gap_key ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_knowledge_gaps_type_allowed check (gap_type in (
    'identity', 'membership', 'compatibility', 'incompatibility',
    'instructions', 'formulation', 'media', 'safety', 'catalog_coverage'
  )),
  constraint catalog_knowledge_gaps_priority_allowed check (priority in ('critical', 'high', 'medium', 'low')),
  constraint catalog_knowledge_gaps_status_allowed check (status in (
    'open', 'in_progress', 'blocked_external', 'resolved', 'dismissed'
  )),
  constraint catalog_knowledge_gaps_title_not_blank check (length(trim(title)) > 0),
  constraint catalog_knowledge_gaps_question_not_blank check (length(trim(question)) > 0),
  constraint catalog_knowledge_gaps_requirement_not_blank check (length(trim(resolution_requirement)) > 0),
  constraint catalog_knowledge_gaps_resolution_consistent check (
    (status in ('open', 'in_progress', 'blocked_external')
      and resolved_evidence_set_id is null and resolved_at is null)
    or (status = 'resolved' and resolved_evidence_set_id is not null and resolved_at is not null)
    or (status = 'dismissed' and resolved_at is not null)
  ),
  constraint catalog_knowledge_gaps_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index catalog_knowledge_gaps_queue_idx
  on public.catalog_knowledge_gaps(system_id, status, priority, gap_type);
create index catalog_knowledge_gaps_product_idx
  on public.catalog_knowledge_gaps(product_id) where product_id is not null;

create or replace function public.validate_catalog_knowledge_gap_resolution()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status = 'resolved'
     and not public.catalog_assert_approved_evidence(new.resolved_evidence_set_id) then
    raise exception using
      errcode = '23514',
      message = 'Una brecha resuelta necesita evidencia aprobada.';
  end if;
  return new;
end;
$function$;

create trigger catalog_knowledge_gaps_validate
before insert or update on public.catalog_knowledge_gaps
for each row execute function public.validate_catalog_knowledge_gap_resolution();

create trigger catalog_knowledge_gaps_set_updated_at
before update on public.catalog_knowledge_gaps
for each row execute function public.set_updated_at();

alter table public.catalog_knowledge_gaps enable row level security;

create policy "admins manage catalog knowledge gaps"
on public.catalog_knowledge_gaps for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.catalog_knowledge_gaps to authenticated;
grant select, insert, update, delete on public.catalog_knowledge_gaps to service_role;

-- Fuentes reproducibles de esta decisión: el Excel entregado por el negocio,
-- documentación oficial de fabricantes y guías oficiales de seguridad.
insert into public.catalog_sources(
  source_key, name, authority, adapter, base_url, brand_id,
  refresh_interval, last_success_at, is_active, metadata
)
select
  source.source_key,
  source.name,
  source.authority,
  source.adapter,
  source.base_url,
  brand.id,
  null,
  now(),
  true,
  source.metadata
from (values
  (
    'bellaroshe-workbook-v2', 'Listado organizado Bellaroshé V2',
    'internal_document', 'spreadsheet', 'https://catalog.internal.bellaroshe', null::text,
    '{"file_name":"Listado_organizado_productos_Bellaroshe.xlsx","sha256":"8180598aab39a5f19d28986034a8d79b6daae4ba01f2ff97b84650b01344fe29"}'::jsonb
  ),
  (
    'acrylove-official-education', 'AcryLove · educación oficial de Acrílico',
    'official', 'html', 'https://acrylove.com', 'ACRYLOVE', '{}'::jsonb
  ),
  (
    'mc-nails-official-acrylic', 'MC Nails · documentación oficial de Acrílico',
    'official', 'html', 'https://mcnails.mx', 'MC NAILS', '{}'::jsonb
  ),
  (
    'masglo-official-acrylic', 'Masglo · documentación oficial de Acrílico',
    'official', 'html', 'https://masglo.com.es', 'Masglo', '{}'::jsonb
  ),
  (
    'mia-secret-official-acrylic', 'Mia Secret · documentación oficial de Acrílico',
    'official', 'html', 'https://miasecret.com', 'MIA SECRET', '{}'::jsonb
  ),
  (
    'cherimoya-official-acrylic', 'Cherimoya · documentación oficial de Acrílico',
    'official', 'html', 'https://cherimoya.pe', 'Cherimoya', '{}'::jsonb
  ),
  (
    'fda-nail-care-guidance', 'FDA · Nail Care Products',
    'official', 'html', 'https://www.fda.gov', null::text, '{}'::jsonb
  ),
  (
    'niosh-nail-salon-guidance', 'NIOSH · seguridad en uñas artificiales',
    'official', 'html', 'https://www.cdc.gov', null::text, '{}'::jsonb
  )
) as source(source_key, name, authority, adapter, base_url, brand_name, metadata)
left join public.brands brand on lower(brand.name) = lower(source.brand_name)
on conflict (source_key) do update set
  name = excluded.name,
  authority = excluded.authority,
  adapter = excluded.adapter,
  base_url = excluded.base_url,
  brand_id = excluded.brand_id,
  last_success_at = excluded.last_success_at,
  is_active = true,
  metadata = excluded.metadata;

insert into public.catalog_source_snapshots(
  source_id, status, started_at, completed_at, content_hash,
  product_count, variant_count, image_count, metadata
)
select
  source.id, 'succeeded', now(), now(), snapshot.content_hash,
  0, 0, 0, snapshot.metadata
from (values
  ('bellaroshe-workbook-v2', 'sha256:8180598aab39a5f19d28986034a8d79b6daae4ba01f2ff97b84650b01344fe29', '{"sheet":"Catálogo organizado","acrylic_range":"A1354:I1449","acrylic_rows":96}'::jsonb),
  ('acrylove-official-education', 'manual:2026-08-10:acrylic:v1', '{"captured_on":"2026-08-10"}'::jsonb),
  ('mc-nails-official-acrylic', 'manual:2026-08-10:acrylic:v1', '{"captured_on":"2026-08-10"}'::jsonb),
  ('masglo-official-acrylic', 'manual:2026-08-10:acrylic:v1', '{"captured_on":"2026-08-10"}'::jsonb),
  ('mia-secret-official-acrylic', 'manual:2026-08-10:acrylic:v1', '{"captured_on":"2026-08-10"}'::jsonb),
  ('cherimoya-official-acrylic', 'manual:2026-08-10:acrylic:v1', '{"captured_on":"2026-08-10"}'::jsonb),
  ('fda-nail-care-guidance', 'manual:2026-08-10:nail-care:v1', '{"captured_on":"2026-08-10"}'::jsonb),
  ('niosh-nail-salon-guidance', 'manual:2026-08-10:artificial-nails:v1', '{"captured_on":"2026-08-10"}'::jsonb)
) as snapshot(source_key, content_hash, metadata)
join public.catalog_sources source on source.source_key = snapshot.source_key
on conflict (source_id, content_hash)
where content_hash is not null and status in ('succeeded', 'partial')
do nothing;

with source_documents(source_key, content_hash, external_id, title, source_url, payload) as (
  values
  (
    'bellaroshe-workbook-v2',
    'sha256:8180598aab39a5f19d28986034a8d79b6daae4ba01f2ff97b84650b01344fe29',
    '8180598aab39a5f19d28986034a8d79b6daae4ba01f2ff97b84650b01344fe29',
    'Listado organizado de productos Bellaroshé V2',
    'https://catalog.internal.bellaroshe/source/listado-organizado-v2',
    $json${
      "file_name":"Listado_organizado_productos_Bellaroshe.xlsx",
      "sha256":"8180598aab39a5f19d28986034a8d79b6daae4ba01f2ff97b84650b01344fe29",
      "sheet":"Catálogo organizado",
      "acrylic_range":"A1354:I1449",
      "acrylic_rows":96,
      "meaning":"Los nombres provienen de lo impreso en el envase, según confirmación del negocio; prueban identidad funcional, no compatibilidad química."
    }$json$::jsonb
  ),
  (
    'acrylove-official-education', 'manual:2026-08-10:acrylic:v1',
    'workflow-2022-12-06', 'Aprende a preparar la uña para una aplicación con estos tips',
    'https://acrylove.com/blogs/noticias/aprende-a-preparar-la-una-para-una-aplicacion-con-estos-tips',
    $json${"published_on":"2022-12-06","claims":["El flujo oficial incluye limpieza, preparación, tip o molde, primer, monómero, polvo, pincel, limado, cleaner y acabado.","El polvo se recoge con un pincel previamente humedecido en monómero.","El primer se describe como preferible, no como requisito universal.","La lima 100/180 y una pulidora se usan después de secar el material."]}$json$::jsonb
  ),
  (
    'acrylove-official-education', 'manual:2026-08-10:acrylic:v1',
    'beginner-guide-2023-01-31', 'Uñas acrílicas: Guía para principiantes',
    'https://acrylove.com/blogs/noticias/unas-acrilicas-guia-para-principiantes',
    $json${"published_on":"2023-01-31","claims":["El sistema combina polvo acrílico y monómero líquido hasta formar una perla.","El flujo final incluye limado, top coat y aceite de cutícula."]}$json$::jsonb
  ),
  (
    'acrylove-official-education', 'manual:2026-08-10:acrylic:v1',
    'bond-1-14ml', 'ACRY LOVE BOND-1 (DESHIDRATADOR)',
    'https://acrylove.com/products/albon1',
    $json${"claims":["El fabricante identifica BOND-1 como deshidratador."]}$json$::jsonb
  ),
  (
    'acrylove-official-education', 'manual:2026-08-10:acrylic:v1',
    'bond-2-14ml', 'ACRY LOVE BOND-2 (ADHERENTE)',
    'https://acrylove.com/products/albon2',
    $json${"claims":["El fabricante identifica BOND-2 como adherente."]}$json$::jsonb
  ),
  (
    'acrylove-official-education', 'manual:2026-08-10:acrylic:v1',
    'acrylic-remover-8oz', 'ACRY LOVE REMOVER ACRYLIC 8oz',
    'https://acrylove.com/products/alrea8',
    $json${"claims":["El fabricante identifica el producto como removedor para acrílico."]}$json$::jsonb
  ),
  (
    'mc-nails-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'black-and-black-2oz', 'Polvo acrílico 2oz BLACK AND BLACK',
    'https://mcnails.mx/products/polvo-acrilico-2oz-black-and-black',
    $json${"claims":["La instrucción oficial humedece el pincel con líquido acrílico SENS AUREA o FANTASTIC LIQUID antes de tomar polvo.","La mención de dos líquidos es evidencia de alternativas específicas de MC Nails, no de compatibilidad universal entre marcas."]}$json$::jsonb
  ),
  (
    'mc-nails-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'cuore-bond', 'Primer Adherente Acry/Bond Sin ácido CUORE BOND',
    'https://mcnails.mx/products/primer-adherente-acry-bond-sin-acido-cuore-bond',
    $json${"claims":["El nombre oficial declara la función de primer adherente Acry/Bond sin ácido."]}$json$::jsonb
  ),
  (
    'masglo-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'ultrabond-7ml', 'LÍQUIDO ACRÍLICO MASGLO ULTRABOND 7 ML',
    'https://masglo.com.es/products/liquido-para-unas-en-acrilico-ultrabond',
    $json${"claims":["Masglo publica Ultrabond dentro de su sistema para uñas acrílicas.","Ultrabond no es monómero y no sustituye el componente líquido de construcción."]}$json$::jsonb
  ),
  (
    'mia-secret-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'nail-prep', 'Mia Secret Nail Prep',
    'https://miasecret.com/es/products/nail-prep',
    $json${"claims":["Nail Prep es un deshidratador previo a Xtrabond para sistemas acrílicos y de gel."]}$json$::jsonb
  ),
  (
    'mia-secret-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'xtrabond-primer', 'Mia Secret XTRABOND Primer',
    'https://miasecret.com/collections/acrylic-nail-system-1/products/xtrabond-primer',
    $json${"claims":["XTRABOND es un primer sin ácido para incrementar la adhesión en sistemas acrílicos y de gel.","El fabricante recomienda usarlo después de Nail Prep."]}$json$::jsonb
  ),
  (
    'mia-secret-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'ema-liquid-monomer', 'Mia Secret Advanced EMA Liquid Monomer',
    'https://miasecret.com/es/products/ema-liquid-monomer',
    $json${"claims":["El fabricante declara compatibilidad con su propia gama de polvos acrílicos.","La página enlaza una SDS; esta evidencia no se extrapola a monómeros Bellaroshé de identidad no reconciliada."]}$json$::jsonb
  ),
  (
    'cherimoya-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'prime-bond', 'Cherimoya Prime Bond / Adhere',
    'https://cherimoya.pe/producto/prime-bond/',
    $json${"claims":["Cherimoya declara uso en esmaltado permanente, sistema acrílico y powder gel."]}$json$::jsonb
  ),
  (
    'cherimoya-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'kolinsky-02', 'Cherimoya Pincel Kolinsky #02',
    'https://cherimoya.pe/producto/002-pincel-kolinsky/',
    $json${"claims":["El fabricante declara que el pincel es para sistema acrílico profesional."]}$json$::jsonb
  ),
  (
    'cherimoya-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'kolinsky-04', 'Cherimoya Pincel Kolinsky #04',
    'https://cherimoya.pe/producto/pincel-kolinsky4/',
    $json${"claims":["El fabricante declara que el pincel es para sistema acrílico profesional."]}$json$::jsonb
  ),
  (
    'cherimoya-official-acrylic', 'manual:2026-08-10:acrylic:v1',
    'kolinsky-12', 'Cherimoya Pincel Kolinsky #12',
    'https://cherimoya.pe/producto/pincel-kolinsky12/',
    $json${"claims":["El fabricante declara que el pincel es para sistema acrílico profesional."]}$json$::jsonb
  ),
  (
    'fda-nail-care-guidance', 'manual:2026-08-10:nail-care:v1',
    'nail-care-products', 'FDA Nail Care Products',
    'https://www.fda.gov/cosmetics/cosmetic-products/nail-care-products',
    $json${"claims":["Las uñas artificiales se forman al reaccionar monómeros acrílicos con polímeros acrílicos.","La FDA distingue MMA, EMA y ácido metacrílico; no deben inferirse por olor ni por el nombre comercial.","La FDA indica que no existe una prohibición federal específica de MMA en cosméticos, aunque retiró productos con 100% MMA mediante acciones previas."]}$json$::jsonb
  ),
  (
    'niosh-nail-salon-guidance', 'manual:2026-08-10:artificial-nails:v1',
    'niosh-99-112', 'Controlling Chemical Hazards During the Application of Artificial Fingernails',
    'https://www.cdc.gov/niosh/docs/99-112/default.html',
    $json${"claims":["NIOSH recomienda ventilación local, recipientes cerrados y reducción de exposición a vapores y polvo.","La seguridad es una dimensión separada de la compatibilidad comercial del producto."]}$json$::jsonb
  )
)
insert into public.catalog_source_records(
  snapshot_id, source_id, entity_type, external_id, title,
  normalized_name, source_url, payload, captured_at
)
select
  snapshot.id,
  source.id,
  'document',
  document.external_id,
  document.title,
  lower(document.title),
  document.source_url,
  document.payload,
  now()
from source_documents document
join public.catalog_sources source on source.source_key = document.source_key
join public.catalog_source_snapshots snapshot
  on snapshot.source_id = source.id
 and snapshot.content_hash = document.content_hash
on conflict (snapshot_id, entity_type, external_id) do nothing;

insert into public.catalog_evidence_sets(
  evidence_key, version, evidence_type, decision_status, confidence,
  rationale, decided_at, metadata
)
values
  (
    'ACRYLIC_WORKBOOK_IDENTITIES', 1, 'internal_document', 'approved', 0.9900,
    'El Excel entregado por el negocio contiene 96 filas explícitas de polvo, monómero, kits y recipiente. Se usa para identidad funcional, nunca para compatibilidad química.',
    now(), '{"scope":"A1354:I1449","source_rows":96,"canonical_products":23}'::jsonb
  ),
  (
    'ACRYLIC_PROCESS_OFFICIAL', 1, 'official_sources', 'approved', 0.9900,
    'Dos guías oficiales de AcryLove y una instrucción oficial de MC Nails sostienen las etapas y el requisito conceptual polvo más monómero.',
    now(), '{"scope":"system_process","cross_brand_compatibility":false}'::jsonb
  ),
  (
    'ACRYLIC_PREPARATION_PRODUCTS', 1, 'official_sources', 'approved', 0.9800,
    'El Excel fija la identidad interna y las páginas oficiales declaran deshidratadores o adherentes aplicables al sistema acrílico.',
    now(), '{"scope":"preparation_and_adhesion","cross_brand_compatibility":false}'::jsonb
  ),
  (
    'ACRYLIC_APPLICATION_TOOLS', 1, 'official_sources', 'approved', 0.9700,
    'El Excel identifica los pinceles internos y las fuentes oficiales los ubican en la aplicación profesional del sistema acrílico.',
    now(), '{"scope":"application_tools"}'::jsonb
  ),
  (
    'ACRYLIC_WORKFLOW_PRODUCTS', 1, 'official_sources', 'approved', 0.9600,
    'El texto interno identifica el producto y la guía oficial sostiene la función de molde, lima, cleaner, top, aceite y removedor dentro del ciclo de Acrílico.',
    now(), '{"scope":"supporting_workflow_products"}'::jsonb
  ),
  (
    'ACRYLIC_SAFETY_OFFICIAL', 1, 'official_sources', 'approved', 0.9900,
    'FDA y NIOSH respaldan la necesidad de leer formulación/SDS y aplicar controles de exposición; no convierten olor o marca en una conclusión química.',
    now(), '{"scope":"safety_and_formulation"}'::jsonb
  )
on conflict (evidence_key, version) do update set
  evidence_type = excluded.evidence_type,
  decision_status = excluded.decision_status,
  confidence = excluded.confidence,
  rationale = excluded.rationale,
  decided_at = excluded.decided_at,
  metadata = excluded.metadata;

with evidence_links(evidence_key, source_key, external_id, notes) as (
  values
  ('ACRYLIC_WORKBOOK_IDENTITIES', 'bellaroshe-workbook-v2', '8180598aab39a5f19d28986034a8d79b6daae4ba01f2ff97b84650b01344fe29', 'Documento interno y hash de la fuente.'),
  ('ACRYLIC_PROCESS_OFFICIAL', 'acrylove-official-education', 'workflow-2022-12-06', 'Proceso completo de aplicación.'),
  ('ACRYLIC_PROCESS_OFFICIAL', 'acrylove-official-education', 'beginner-guide-2023-01-31', 'Corrobora polvo, monómero, limado y acabado.'),
  ('ACRYLIC_PROCESS_OFFICIAL', 'mc-nails-official-acrylic', 'black-and-black-2oz', 'Corrobora el uso de líquido acrílico con polvo.'),
  ('ACRYLIC_PREPARATION_PRODUCTS', 'bellaroshe-workbook-v2', '8180598aab39a5f19d28986034a8d79b6daae4ba01f2ff97b84650b01344fe29', 'Identidad interna de los productos.'),
  ('ACRYLIC_PREPARATION_PRODUCTS', 'acrylove-official-education', 'workflow-2022-12-06', 'La preparación y el primer forman parte del flujo.'),
  ('ACRYLIC_PREPARATION_PRODUCTS', 'acrylove-official-education', 'bond-1-14ml', 'BOND-1 se declara deshidratador.'),
  ('ACRYLIC_PREPARATION_PRODUCTS', 'acrylove-official-education', 'bond-2-14ml', 'BOND-2 se declara adherente.'),
  ('ACRYLIC_PREPARATION_PRODUCTS', 'mc-nails-official-acrylic', 'cuore-bond', 'Cuore Bond declara uso Acry/Bond.'),
  ('ACRYLIC_PREPARATION_PRODUCTS', 'masglo-official-acrylic', 'ultrabond-7ml', 'Ultrabond se publica para uñas acrílicas.'),
  ('ACRYLIC_PREPARATION_PRODUCTS', 'mia-secret-official-acrylic', 'nail-prep', 'Nail Prep se declara deshidratador para acrílico.'),
  ('ACRYLIC_PREPARATION_PRODUCTS', 'mia-secret-official-acrylic', 'xtrabond-primer', 'Xtrabond se declara primer para acrílico.'),
  ('ACRYLIC_APPLICATION_TOOLS', 'bellaroshe-workbook-v2', '8180598aab39a5f19d28986034a8d79b6daae4ba01f2ff97b84650b01344fe29', 'Identidad interna de los pinceles.'),
  ('ACRYLIC_APPLICATION_TOOLS', 'acrylove-official-education', 'workflow-2022-12-06', 'El proceso exige pincel para formar la perla.'),
  ('ACRYLIC_APPLICATION_TOOLS', 'cherimoya-official-acrylic', 'kolinsky-02', 'Uso profesional en acrílico.'),
  ('ACRYLIC_APPLICATION_TOOLS', 'cherimoya-official-acrylic', 'kolinsky-04', 'Uso profesional en acrílico.'),
  ('ACRYLIC_APPLICATION_TOOLS', 'cherimoya-official-acrylic', 'kolinsky-12', 'Uso profesional en acrílico.'),
  ('ACRYLIC_WORKFLOW_PRODUCTS', 'bellaroshe-workbook-v2', '8180598aab39a5f19d28986034a8d79b6daae4ba01f2ff97b84650b01344fe29', 'Identidad interna de consumibles y apoyo.'),
  ('ACRYLIC_WORKFLOW_PRODUCTS', 'acrylove-official-education', 'workflow-2022-12-06', 'Sostiene molde, limado, cleaner y top.'),
  ('ACRYLIC_WORKFLOW_PRODUCTS', 'acrylove-official-education', 'beginner-guide-2023-01-31', 'Sostiene top y aceite de cutícula.'),
  ('ACRYLIC_WORKFLOW_PRODUCTS', 'acrylove-official-education', 'acrylic-remover-8oz', 'Sostiene la función del removedor.'),
  ('ACRYLIC_SAFETY_OFFICIAL', 'fda-nail-care-guidance', 'nail-care-products', 'Diferencia química y precauciones de uso.'),
  ('ACRYLIC_SAFETY_OFFICIAL', 'niosh-nail-salon-guidance', 'niosh-99-112', 'Controles de exposición ocupacional.')
)
insert into public.catalog_evidence_items(evidence_set_id, source_record_id, stance, notes)
select evidence.id, record.id, 'supports', link.notes
from evidence_links link
join public.catalog_evidence_sets evidence
  on evidence.evidence_key = link.evidence_key and evidence.version = 1
join public.catalog_sources source on source.source_key = link.source_key
join public.catalog_source_records record
  on record.source_id = source.id and record.external_id = link.external_id
on conflict (evidence_set_id, source_record_id, stance)
where source_record_id is not null
do nothing;

-- El flujo oficial coloca la preparación de la extensión entre la preparación
-- de la placa y la adhesión. Remoción pertenece al ciclo de vida, no a la
-- construcción, por eso tiene una etapa separada.
insert into public.catalog_stages(system_id, code, name, position, description)
select system.id, stage.code, stage.name, stage.position, stage.description
from public.catalog_systems system
cross join (values
  ('EXTENSION_SETUP', 'Preparar extensión', 15, 'Seleccionar y colocar molde o tip cuando la técnica lo requiera.'),
  ('REMOVAL', 'Retirar', 60, 'Retirar el sistema con producto y procedimiento declarado para acrílico.')
) as stage(code, name, position, description)
where system.code = 'ACRYLIC'
on conflict (system_id, code) do update set
  name = excluded.name,
  position = excluded.position,
  description = excluded.description,
  is_active = true;

insert into public.catalog_roles(code, name, role_kind, description)
values
  ('SANITIZING_AGENT', 'Sanitizante', 'preparation', 'Limpia o sanitiza antes de la aplicación.'),
  ('PREPARATION_TOOL', 'Herramienta de preparación', 'tool', 'Prepara la placa o el borde antes de construir.'),
  ('EXTENSION_SUPPORT', 'Soporte de extensión', 'consumable', 'Molde o tip utilizado para definir largo y forma.'),
  ('LIQUID_VESSEL', 'Recipiente para líquido', 'tool', 'Recipiente de trabajo para dosificar el monómero.'),
  ('DUST_REMOVAL_TOOL', 'Herramienta para retirar polvo', 'tool', 'Retira residuos después del limado.'),
  ('SURFACE_CLEANSER', 'Limpiador de superficie', 'consumable', 'Limpia la superficie después del perfeccionamiento.'),
  ('REMOVAL_PRODUCT', 'Producto de remoción', 'care', 'Producto declarado para retirar el sistema acrílico.'),
  ('AFTERCARE_PRODUCT', 'Cuidado posterior', 'care', 'Producto de cuidado aplicado al terminar el servicio.')
on conflict (code) do update set
  name = excluded.name,
  role_kind = excluded.role_kind,
  description = excluded.description,
  is_active = true;

insert into public.catalog_classes(code, name, target_scope, description)
values
  ('ACRYLIC_KIT', 'Kit acrílico', 'product', 'Kit declarado para Acrílico cuyo contenido debe evaluarse antes de cubrir roles.'),
  ('ACRYLIC_DEHYDRATOR', 'Deshidratador para acrílico', 'product', 'Preparador declarado para retirar humedad o aceites antes del sistema.'),
  ('ACRYLIC_LIQUID_VESSEL', 'Recipiente de monómero', 'product', 'Recipiente de trabajo; no es el componente líquido.'),
  ('ACRYLIC_SHAPING_FILE', 'Lima para acrílico', 'product', 'Lima o pulidor con función declarada en el proceso acrílico.'),
  ('ACRYLIC_NAIL_FORM', 'Molde para acrílico', 'product', 'Molde de extensión utilizado en el sistema acrílico.'),
  ('ACRYLIC_TIP', 'Tip para acrílico', 'product', 'Tip de extensión declarado para el sistema acrílico.'),
  ('ACRYLIC_CLEANSER', 'Limpiador para proceso acrílico', 'product', 'Limpiador de superficie utilizado dentro del proceso.'),
  ('ACRYLIC_REMOVER', 'Removedor de acrílico', 'product', 'Producto declarado para retirar acrílico.'),
  ('ACRYLIC_AFTERCARE', 'Cuidado posterior de acrílico', 'product', 'Producto aplicado al terminar el servicio, como aceite de cutícula.'),
  ('ACRYLIC_SANITIZER', 'Sanitizante para proceso acrílico', 'product', 'Producto de sanitización declarado para la preparación.'),
  ('ACRYLIC_DUST_BRUSH', 'Cepillo para polvo acrílico', 'product', 'Herramienta declarada para retirar polvo del limado.')
on conflict (code) do update set
  name = excluded.name,
  target_scope = excluded.target_scope,
  description = excluded.description,
  is_active = true;

-- Lo requerido aquí sirve para calcular “qué falta”; no bloquea edición,
-- publicación ni productos sin precio.
with role_expectations(stage_code, role_code, necessity, minimum_selections, maximum_selections) as (
  values
  ('PREPARATION', 'SANITIZING_AGENT', 'recommended', 1, 1),
  ('PREPARATION', 'PREPARATION_AGENT', 'recommended', 1, 1),
  ('PREPARATION', 'PREPARATION_TOOL', 'recommended', 1, 1),
  ('EXTENSION_SETUP', 'EXTENSION_SUPPORT', 'optional', 0, 1),
  ('ADHESION', 'ADHESION_AGENT', 'recommended', 1, 1),
  ('CONSTRUCTION', 'POLYMER_COMPONENT', 'required', 1, 1),
  ('CONSTRUCTION', 'LIQUID_COMPONENT', 'required', 1, 1),
  ('CONSTRUCTION', 'APPLICATION_TOOL', 'required', 1, 1),
  ('CONSTRUCTION', 'LIQUID_VESSEL', 'recommended', 1, 1),
  ('SHAPING', 'SHAPING_TOOL', 'recommended', 1, 2),
  ('SHAPING', 'DUST_REMOVAL_TOOL', 'recommended', 1, 1),
  ('SHAPING', 'SURFACE_CLEANSER', 'recommended', 1, 1),
  ('FINISHING', 'FINISHING_PRODUCT', 'optional', 0, 1),
  ('FINISHING', 'AFTERCARE_PRODUCT', 'optional', 0, 1),
  ('REMOVAL', 'REMOVAL_PRODUCT', 'optional', 0, 1)
), context as (
  select system.id as system_id, evidence.id as evidence_set_id
  from public.catalog_systems system
  join public.catalog_evidence_sets evidence
    on evidence.evidence_key = 'ACRYLIC_PROCESS_OFFICIAL' and evidence.version = 1
  where system.code = 'ACRYLIC'
)
insert into public.catalog_system_stage_roles(
  system_id, stage_id, role_id, necessity, minimum_selections,
  maximum_selections, decision_status, evidence_set_id, is_active, metadata
)
select
  context.system_id,
  stage.id,
  role.id,
  expectation.necessity,
  expectation.minimum_selections,
  expectation.maximum_selections,
  'approved',
  context.evidence_set_id,
  true,
  '{"behavior":"recommendation_engine","publication_blocking":false,"price_required":false}'::jsonb
from context
join public.catalog_stages stage on stage.system_id = context.system_id
join role_expectations expectation on expectation.stage_code = stage.code
join public.catalog_roles role on role.code = expectation.role_code
on conflict (system_id, stage_id, role_id) do update set
  necessity = excluded.necessity,
  minimum_selections = excluded.minimum_selections,
  maximum_selections = excluded.maximum_selections,
  decision_status = excluded.decision_status,
  evidence_set_id = excluded.evidence_set_id,
  is_active = true,
  metadata = excluded.metadata;

-- Membresías de clase. El kit Cherimoya no se marca como polímero porque no se
-- conocen sus contenidos; la corona de vidrio se marca como recipiente, nunca
-- como monómero.
with memberships(product_code, class_code, evidence_key) as (
  values
  ('ACR-SIS-76B253', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('ACR-SIS-D2A8F8', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('ACR-SIS-103257', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('CHE-SIS-47EC19', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('CHE-SIS-9B9E24', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MAS-SIS-47C01E', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MAS-SIS-32A06E', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-55882A', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-773791', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-EF013F', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-A046F8', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MIA-SIS-BE52CE', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MYS-SIS-D30483', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('GEN-SIS-FD2ED7', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('WAP-SIS-E5912B', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('WAP-SIS-F28187', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('WAP-SIS-C7E17B', 'ACRYLIC_POLYMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('ACR-SIS-2958BA', 'ACRYLIC_MONOMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('CHE-SIS-C15709', 'ACRYLIC_MONOMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-59413F', 'ACRYLIC_MONOMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-169497', 'ACRYLIC_MONOMER', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('CHE-SIS-2D28E7', 'ACRYLIC_KIT', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('GEN-SIS-0687B8', 'ACRYLIC_LIQUID_VESSEL', 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('ACR-PRE-1C3A18', 'ACRYLIC_DEHYDRATOR', 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('MIA-PRE-EF86B7', 'ACRYLIC_DEHYDRATOR', 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('ACR-PRE-3FBDDC', 'ACRYLIC_PRIMER', 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('MAS-PRE-C83A0D', 'ACRYLIC_PRIMER', 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('MIA-PRE-753380', 'ACRYLIC_PRIMER', 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('MCN-PRE-6CB7C4', 'ACRYLIC_PRIMER', 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('ACR-PIN-5C586F', 'ACRYLIC_BRUSH', 'ACRYLIC_APPLICATION_TOOLS'),
  ('ACR-PIN-D16329', 'ACRYLIC_BRUSH', 'ACRYLIC_APPLICATION_TOOLS'),
  ('ACR-PIN-22AEF2', 'ACRYLIC_BRUSH', 'ACRYLIC_APPLICATION_TOOLS'),
  ('ACR-PIN-E8EDFE', 'ACRYLIC_BRUSH', 'ACRYLIC_APPLICATION_TOOLS'),
  ('CHE-PIN-7DD1D1', 'ACRYLIC_BRUSH', 'ACRYLIC_APPLICATION_TOOLS'),
  ('CHE-PIN-F3A725', 'ACRYLIC_BRUSH', 'ACRYLIC_APPLICATION_TOOLS'),
  ('CHE-PIN-2C2F1D', 'ACRYLIC_BRUSH', 'ACRYLIC_APPLICATION_TOOLS'),
  ('CHE-PIN-D1562D', 'ACRYLIC_BRUSH', 'ACRYLIC_APPLICATION_TOOLS'),
  ('ACR-LIM-24A62F', 'ACRYLIC_SHAPING_FILE', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-LIM-E5CC3E', 'ACRYLIC_SHAPING_FILE', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-LIM-3E4C83', 'ACRYLIC_SHAPING_FILE', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-MOL-22F2B3', 'ACRYLIC_NAIL_FORM', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-REM-EEDFBC', 'ACRYLIC_CLEANSER', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-BAS-A95913', 'ACRYLIC_TOP_COAT', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-REM-EE99FA', 'ACRYLIC_REMOVER', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-A91B36', 'ACRYLIC_AFTERCARE', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-51BCE8', 'ACRYLIC_AFTERCARE', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-ABB528', 'ACRYLIC_AFTERCARE', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-515B14', 'ACRYLIC_AFTERCARE', 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-70B098', 'ACRYLIC_AFTERCARE', 'ACRYLIC_WORKFLOW_PRODUCTS')
)
insert into public.catalog_class_members(
  class_id, product_id, origin, decision_status, evidence_set_id, metadata
)
select
  class.id,
  product.id,
  'manual',
  'approved',
  evidence.id,
  jsonb_build_object('vertical', 'ACRYLIC', 'product_code', product.code)
from memberships membership
join public.products product on product.code = membership.product_code
join public.catalog_classes class on class.code = membership.class_code
join public.catalog_evidence_sets evidence
  on evidence.evidence_key = membership.evidence_key and evidence.version = 1
on conflict (class_id, target_ref) do update set
  origin = excluded.origin,
  source_rule_group = null,
  decision_status = excluded.decision_status,
  evidence_set_id = excluded.evidence_set_id,
  computed_at = null,
  metadata = excluded.metadata;

with assignments(product_code, stage_code, role_code, required_role, evidence_key) as (
  values
  ('ACR-SIS-76B253', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('ACR-SIS-D2A8F8', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('ACR-SIS-103257', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('CHE-SIS-47EC19', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('CHE-SIS-9B9E24', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MAS-SIS-47C01E', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MAS-SIS-32A06E', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-55882A', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-773791', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-EF013F', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-A046F8', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MIA-SIS-BE52CE', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MYS-SIS-D30483', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('GEN-SIS-FD2ED7', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('WAP-SIS-E5912B', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('WAP-SIS-F28187', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('WAP-SIS-C7E17B', 'CONSTRUCTION', 'POLYMER_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('ACR-SIS-2958BA', 'CONSTRUCTION', 'LIQUID_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('CHE-SIS-C15709', 'CONSTRUCTION', 'LIQUID_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-59413F', 'CONSTRUCTION', 'LIQUID_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('MCN-SIS-169497', 'CONSTRUCTION', 'LIQUID_COMPONENT', true, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('GEN-SIS-0687B8', 'CONSTRUCTION', 'LIQUID_VESSEL', false, 'ACRYLIC_WORKBOOK_IDENTITIES'),
  ('ACR-PRE-1C3A18', 'PREPARATION', 'PREPARATION_AGENT', false, 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('MIA-PRE-EF86B7', 'PREPARATION', 'PREPARATION_AGENT', false, 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('ACR-PRE-3FBDDC', 'ADHESION', 'ADHESION_AGENT', false, 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('MAS-PRE-C83A0D', 'ADHESION', 'ADHESION_AGENT', false, 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('MIA-PRE-753380', 'ADHESION', 'ADHESION_AGENT', false, 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('MCN-PRE-6CB7C4', 'ADHESION', 'ADHESION_AGENT', false, 'ACRYLIC_PREPARATION_PRODUCTS'),
  ('ACR-PIN-5C586F', 'CONSTRUCTION', 'APPLICATION_TOOL', true, 'ACRYLIC_APPLICATION_TOOLS'),
  ('ACR-PIN-D16329', 'CONSTRUCTION', 'APPLICATION_TOOL', true, 'ACRYLIC_APPLICATION_TOOLS'),
  ('ACR-PIN-22AEF2', 'CONSTRUCTION', 'APPLICATION_TOOL', true, 'ACRYLIC_APPLICATION_TOOLS'),
  ('ACR-PIN-E8EDFE', 'CONSTRUCTION', 'APPLICATION_TOOL', true, 'ACRYLIC_APPLICATION_TOOLS'),
  ('CHE-PIN-7DD1D1', 'CONSTRUCTION', 'APPLICATION_TOOL', true, 'ACRYLIC_APPLICATION_TOOLS'),
  ('CHE-PIN-F3A725', 'CONSTRUCTION', 'APPLICATION_TOOL', true, 'ACRYLIC_APPLICATION_TOOLS'),
  ('CHE-PIN-2C2F1D', 'CONSTRUCTION', 'APPLICATION_TOOL', true, 'ACRYLIC_APPLICATION_TOOLS'),
  ('CHE-PIN-D1562D', 'CONSTRUCTION', 'APPLICATION_TOOL', true, 'ACRYLIC_APPLICATION_TOOLS'),
  ('ACR-LIM-E5CC3E', 'PREPARATION', 'PREPARATION_TOOL', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-LIM-24A62F', 'SHAPING', 'SHAPING_TOOL', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-LIM-3E4C83', 'SHAPING', 'SHAPING_TOOL', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-MOL-22F2B3', 'EXTENSION_SETUP', 'EXTENSION_SUPPORT', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-REM-EEDFBC', 'SHAPING', 'SURFACE_CLEANSER', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-BAS-A95913', 'FINISHING', 'FINISHING_PRODUCT', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-REM-EE99FA', 'REMOVAL', 'REMOVAL_PRODUCT', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-A91B36', 'FINISHING', 'AFTERCARE_PRODUCT', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-51BCE8', 'FINISHING', 'AFTERCARE_PRODUCT', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-ABB528', 'FINISHING', 'AFTERCARE_PRODUCT', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-515B14', 'FINISHING', 'AFTERCARE_PRODUCT', false, 'ACRYLIC_WORKFLOW_PRODUCTS'),
  ('ACR-CUI-70B098', 'FINISHING', 'AFTERCARE_PRODUCT', false, 'ACRYLIC_WORKFLOW_PRODUCTS')
), context as (
  select system.id as system_id
  from public.catalog_systems system where system.code = 'ACRYLIC'
)
insert into public.product_system_roles(
  product_id, system_id, stage_id, role_id, is_primary, is_required,
  decision_status, evidence_set_id, metadata
)
select
  product.id,
  context.system_id,
  stage.id,
  role.id,
  true,
  assignment.required_role,
  'approved',
  evidence.id,
  jsonb_build_object('vertical', 'ACRYLIC', 'product_code', product.code)
from assignments assignment
cross join context
join public.products product on product.code = assignment.product_code
join public.catalog_stages stage
  on stage.system_id = context.system_id and stage.code = assignment.stage_code
join public.catalog_roles role on role.code = assignment.role_code
join public.catalog_evidence_sets evidence
  on evidence.evidence_key = assignment.evidence_key and evidence.version = 1
on conflict (target_ref, system_id, stage_id, role_id)
where decision_status in ('proposed', 'needs_evidence', 'approved')
do update set
  is_primary = excluded.is_primary,
  is_required = excluded.is_required,
  decision_status = excluded.decision_status,
  evidence_set_id = excluded.evidence_set_id,
  metadata = excluded.metadata;

-- La regla conceptual no elige una marca ni genera producto→producto. Solo
-- afirma que el polímero necesita un monómero cuya compatibilidad sea probada.
update public.catalog_relation_rules rule
set
  compatibility_status = 'conditional',
  requirement_level = 'required',
  brand_policy = 'explicit_evidence',
  decision_status = 'approved',
  evidence_set_id = evidence.id,
  notes = 'El polímero requiere un monómero compatible. La regla no autoriza cruces de marca ni sustituye una matriz/SDS del fabricante.',
  metadata = '{"generates_cross_brand_edges":false,"requires_pair_evidence":true}'::jsonb,
  is_active = true
from public.catalog_evidence_sets evidence
where rule.code = 'ACRYLIC_POLYMER_REQUIRES_MONOMER'
  and evidence.evidence_key = 'ACRYLIC_PROCESS_OFFICIAL'
  and evidence.version = 1;

insert into public.catalog_relation_rules(
  code, source_class_id, target_class_id, relation_type, compatibility_status,
  system_id, stage_id, requirement_level, brand_policy, decision_status,
  evidence_set_id, notes, metadata, is_active
)
select
  'ACRYLIC_FORM_ALTERNATIVE_TO_TIP',
  source.id,
  target.id,
  'alternative_to',
  'conditional',
  system.id,
  stage.id,
  'optional',
  'explicit_evidence',
  'approved',
  evidence.id,
  'Molde y tip son alternativas de soporte; la aptitud del producto concreto necesita evidencia.',
  '{"symmetric":true,"does_not_imply_product_compatibility":true}'::jsonb,
  true
from public.catalog_classes source
join public.catalog_classes target on target.code = 'ACRYLIC_TIP'
join public.catalog_systems system on system.code = 'ACRYLIC'
join public.catalog_stages stage on stage.system_id = system.id and stage.code = 'EXTENSION_SETUP'
join public.catalog_evidence_sets evidence
  on evidence.evidence_key = 'ACRYLIC_PROCESS_OFFICIAL' and evidence.version = 1
where source.code = 'ACRYLIC_NAIL_FORM'
on conflict (code) do update set
  source_class_id = excluded.source_class_id,
  target_class_id = excluded.target_class_id,
  relation_type = excluded.relation_type,
  compatibility_status = excluded.compatibility_status,
  system_id = excluded.system_id,
  stage_id = excluded.stage_id,
  requirement_level = excluded.requirement_level,
  brand_policy = excluded.brand_policy,
  decision_status = excluded.decision_status,
  evidence_set_id = excluded.evidence_set_id,
  notes = excluded.notes,
  metadata = excluded.metadata,
  is_active = true;

-- Clasificación reejecutable para que un reset + staging posterior conserve la
-- misma semántica. Solo toca candidatas aún pendientes.
create or replace function public.classify_acrylic_relation_candidates_v1()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  incorrect_count integer := 0;
  class_rule_count integer := 0;
  system_role_count integer := 0;
  insufficient_count integer := 0;
begin
  update public.catalog_relation_candidates candidate
  set
    status = 'rejected',
    resolution_kind = 'incorrect',
    promoted_product_relation_id = null,
    promoted_relation_rule_id = null,
    promoted_system_role_id = null,
    promoted_class_member_id = null,
    decided_at = now(),
    evidence = candidate.evidence || jsonb_build_object(
      'classification', 'incorrect',
      'decision_reason', 'El destino es un recipiente para monómero, no el componente líquido.'
    )
  from public.products target
  where candidate.target_product_id = target.id
    and target.code = 'GEN-SIS-0687B8'
    and candidate.rule_code = 'acrylic_powder->monomer'
    and candidate.status in ('proposed', 'needs_evidence');
  get diagnostics incorrect_count = row_count;

  update public.catalog_relation_candidates candidate
  set
    status = 'promoted',
    resolution_kind = 'class_rule',
    promoted_product_relation_id = null,
    promoted_relation_rule_id = relation_rule.id,
    promoted_system_role_id = null,
    promoted_class_member_id = null,
    decided_at = now(),
    evidence = candidate.evidence || jsonb_build_object(
      'classification', 'class_rule',
      'decision_reason', 'El par se normaliza como una sola regla clase→clase; no se aprueba la pareja concreta.'
    )
  from public.catalog_relation_rules relation_rule,
       public.catalog_class_members source_member,
       public.catalog_classes source_class,
       public.catalog_class_members target_member,
       public.catalog_classes target_class
  where relation_rule.code = 'ACRYLIC_POLYMER_REQUIRES_MONOMER'
    and relation_rule.decision_status = 'approved'
    and source_member.product_id = candidate.source_product_id
    and source_member.class_id = source_class.id
    and source_class.code = 'ACRYLIC_POLYMER'
    and source_member.decision_status = 'approved'
    and target_member.product_id = candidate.target_product_id
    and target_member.class_id = target_class.id
    and target_class.code = 'ACRYLIC_MONOMER'
    and target_member.decision_status = 'approved'
    and candidate.rule_code = 'acrylic_powder->monomer'
    and candidate.confidence = 'same_brand_rule'
    and candidate.status in ('proposed', 'needs_evidence');
  get diagnostics class_rule_count = row_count;

  update public.catalog_relation_candidates candidate
  set
    status = 'promoted',
    resolution_kind = 'system_role',
    promoted_product_relation_id = null,
    promoted_relation_rule_id = null,
    promoted_system_role_id = assignment.id,
    promoted_class_member_id = null,
    decided_at = now(),
    evidence = candidate.evidence || jsonb_build_object(
      'classification', 'system_role',
      'decision_reason', 'La candidata no es un par canónico: el destino cubre un rol de preparación o adhesión.'
    )
  from public.product_system_roles assignment,
       public.products target,
       public.catalog_systems system,
       public.catalog_roles role
  where candidate.target_product_id = target.id
    and target.code in (
      'ACR-PRE-1C3A18', 'ACR-PRE-3FBDDC', 'MAS-PRE-C83A0D',
      'MIA-PRE-EF86B7', 'MIA-PRE-753380', 'MCN-PRE-6CB7C4'
    )
    and assignment.product_id = target.id
    and assignment.system_id = system.id
    and system.code = 'ACRYLIC'
    and assignment.role_id = role.id
    and role.code in ('PREPARATION_AGENT', 'ADHESION_AGENT')
    and assignment.decision_status = 'approved'
    and candidate.rule_code = 'acrylic_powder->primer'
    and candidate.status in ('proposed', 'needs_evidence');
  get diagnostics system_role_count = row_count;

  update public.catalog_relation_candidates candidate
  set
    status = 'rejected',
    resolution_kind = 'insufficient_evidence',
    promoted_product_relation_id = null,
    promoted_relation_rule_id = null,
    promoted_system_role_id = null,
    promoted_class_member_id = null,
    decided_at = now(),
    evidence = candidate.evidence || jsonb_build_object(
      'classification', 'insufficient_evidence',
      'decision_reason', 'El nombre o la marca no prueban que este preparador concreto pertenezca al flujo; se requiere envase, manual o ficha técnica.'
    )
  where candidate.rule_code = 'acrylic_powder->primer'
    and candidate.status in ('proposed', 'needs_evidence');
  get diagnostics insufficient_count = row_count;

  return jsonb_build_object(
    'incorrect', incorrect_count,
    'class_rule', class_rule_count,
    'system_role', system_role_count,
    'insufficient_evidence', insufficient_count,
    'total', incorrect_count + class_rule_count + system_role_count + insufficient_count
  );
end;
$function$;

revoke execute on function public.classify_acrylic_relation_candidates_v1()
from public, anon;
grant execute on function public.classify_acrylic_relation_candidates_v1()
to authenticated, service_role;

select public.classify_acrylic_relation_candidates_v1();

-- Deudas concretas para la captura física y la siguiente ronda de fuentes.
with acrylic as (
  select id from public.catalog_systems where code = 'ACRYLIC'
), gaps(gap_key, product_code, class_code, gap_type, priority, status, title, question, requirement, metadata) as (
  values
  (
    'ACRYLIC_CROSS_BRAND_COMPATIBILITY', null::text, null::text, 'compatibility', 'critical', 'blocked_external',
    'Compatibilidad entre marcas no demostrada',
    '¿Qué pares polvo–monómero están autorizados expresamente entre marcas o líneas?',
    'Matriz del fabricante, manual, ficha técnica o SDS que nombre ambos productos o líneas.',
    '{"do_not_infer_from":["brand","category","name","size"]}'::jsonb
  ),
  (
    'ACRYLIC_MONOMER_FORMULATION_AND_SDS', null::text, 'ACRYLIC_MONOMER', 'formulation', 'critical', 'blocked_external',
    'Formulación y SDS de monómeros internos',
    '¿Cada monómero interno es EMA, MMA u otra formulación y cuál es su SDS vigente?',
    'Foto legible de ingredientes/advertencias y SDS oficial por SKU o línea.',
    '{"do_not_infer_from":["odor","color","marketing_name"],"safety_reference":"FDA_NIOSH"}'::jsonb
  ),
  (
    'ACRYLOVE_COVER_01_16_IDENTITY', 'ACR-SIS-D2A8F8', null::text, 'identity', 'high', 'blocked_external',
    'Identidad de Cover N.1–N.16',
    '¿La serie interna Cover N.1–N.16 corresponde a Makeup, Cover u otra línea oficial de AcryLove?',
    'Foto frontal, posterior, SKU/código de barras y nombre de línea de al menos N.1, N.8 y N.16.',
    '{"sample_variants":["Cover N.1 · 2OZ","Cover N.8 · 2OZ","Cover N.16 · 2OZ"]}'::jsonb
  ),
  (
    'ACRYLOVE_ELEGANT_8_IDENTITY', 'ACR-PIN-3CDBF5', 'ACRYLIC_BRUSH', 'identity', 'medium', 'blocked_external',
    'Pincel Elegant #8 no reconciliado',
    '¿El producto interno es Elegant #8 y está declarado para Acrílico?',
    'Foto del mango, número y empaque; URL o catálogo oficial que muestre exactamente #8.',
    '{}'::jsonb
  ),
  (
    'CHERIMOYA_ACRYLIC_KIT_CONTENTS', 'CHE-SIS-2D28E7', 'ACRYLIC_KIT', 'identity', 'high', 'blocked_external',
    'Contenido del kit acrílico Cherimoya desconocido',
    '¿Qué componentes contiene el kit y qué roles cubre realmente?',
    'Foto del frente y reverso o lista oficial de contenidos con tamaños/SKU.',
    '{"must_not_cover_roles_until_resolved":true}'::jsonb
  ),
  (
    'MC_NAILS_MONOMER_LINE_IDENTITY', 'MCN-SIS-59413F', 'ACRYLIC_MONOMER', 'identity', 'critical', 'blocked_external',
    'Línea exacta del monómero MC Nails desconocida',
    '¿El monómero interno corresponde a SENS AUREA, FANTASTIC LIQUID, Monarca u otra línea?',
    'Foto frontal/posterior y SKU de cada tamaño; cruzar con el catálogo oficial.',
    '{"official_instruction_mentions":["SENS AUREA","FANTASTIC LIQUID"]}'::jsonb
  ),
  (
    'MC_NAILS_BLISS_FUNCTION', 'MCN-PRE-D7C129', null::text, 'membership', 'high', 'blocked_external',
    'Función de MC Bliss sin confirmar',
    '¿El producto es deshidratador, antihongos u otra preparación?',
    'Foto del envase y página/ficha oficial exacta. No usar la coincidencia automática actual.',
    '{"candidate_status":"insufficient_evidence"}'::jsonb
  ),
  (
    'MASGLO_MONOMER_CATALOG_COVERAGE', null::text, 'ACRYLIC_MONOMER', 'catalog_coverage', 'high', 'open',
    'No hay monómero Masglo identificado en el catálogo interno',
    '¿Bellaroshé vende el componente líquido/monómero Masglo o solo Ultrabond?',
    'Confirmar inventario y envase. Ultrabond y la corona de vidrio no son monómero.',
    '{"known_products":["Polvo Acrílico","Polvo Acrílico Champagne","Ultrabond"]}'::jsonb
  ),
  (
    'ACRYLIC_SANITIZER_PRODUCT_MAPPING', null::text, 'ACRYLIC_SANITIZER', 'catalog_coverage', 'medium', 'open',
    'Sanitizante sin producto mapeado',
    '¿Qué producto vendible del catálogo cubre la sanitización previa del sistema Acrílico?',
    'Envase o ficha que declare sanitización/desinfección para preparación de uñas.',
    '{}'::jsonb
  ),
  (
    'ACRYLIC_DUST_BRUSH_PRODUCT_MAPPING', null::text, 'ACRYLIC_DUST_BRUSH', 'catalog_coverage', 'medium', 'open',
    'Cepillo de polvo sin producto mapeado',
    '¿Qué cepillo del catálogo está declarado para retirar polvo de limado?',
    'Foto o ficha de uso del cepillo; no reutilizar pinceles de aplicación por semejanza visual.',
    '{}'::jsonb
  )
)
insert into public.catalog_knowledge_gaps(
  gap_key, system_id, product_id, class_id, gap_type, priority, status,
  title, question, resolution_requirement, metadata
)
select
  gap.gap_key,
  acrylic.id,
  product.id,
  class.id,
  gap.gap_type,
  gap.priority,
  gap.status,
  gap.title,
  gap.question,
  gap.requirement,
  gap.metadata
from gaps gap
cross join acrylic
left join public.products product on product.code = gap.product_code
left join public.catalog_classes class on class.code = gap.class_code
on conflict (gap_key) do update set
  system_id = excluded.system_id,
  product_id = excluded.product_id,
  class_id = excluded.class_id,
  gap_type = excluded.gap_type,
  priority = excluded.priority,
  status = excluded.status,
  title = excluded.title,
  question = excluded.question,
  resolution_requirement = excluded.resolution_requirement,
  metadata = excluded.metadata;

create or replace view public.catalog_acrylic_knowledge_gap_queue_v1
with (security_invoker = true) as
select
  gap.id,
  gap.gap_key,
  gap.gap_type,
  gap.priority,
  gap.status,
  gap.title,
  gap.question,
  gap.resolution_requirement,
  product.code as product_code,
  product.name as product_name,
  class.code as class_code,
  class.name as class_name,
  gap.metadata,
  gap.created_at,
  gap.updated_at
from public.catalog_knowledge_gaps gap
join public.catalog_systems system on system.id = gap.system_id and system.code = 'ACRYLIC'
left join public.products product on product.id = gap.product_id
left join public.catalog_classes class on class.id = gap.class_id
where gap.status in ('open', 'in_progress', 'blocked_external');

grant select on public.catalog_acrylic_knowledge_gap_queue_v1 to authenticated, service_role;

-- Cobertura genérica: permite que el prototipo explique qué tiene, qué falta y
-- qué es opcional sin exigir precio y sin almacenar pares redundantes.
create or replace function public.get_catalog_system_coverage_v1(
  p_system_code text,
  p_product_ids uuid[] default '{}'::uuid[]
)
returns table (
  stage_code text,
  stage_name text,
  stage_position integer,
  role_code text,
  role_name text,
  necessity text,
  minimum_selections integer,
  selected_count bigint,
  is_satisfied boolean
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    stage.code,
    stage.name,
    stage.position,
    role.code,
    role.name,
    expectation.necessity,
    expectation.minimum_selections,
    count(distinct assignment.product_id) filter (
      where assignment.product_id = any(coalesce(p_product_ids, '{}'::uuid[]))
    ) as selected_count,
    count(distinct assignment.product_id) filter (
      where assignment.product_id = any(coalesce(p_product_ids, '{}'::uuid[]))
    ) >= expectation.minimum_selections as is_satisfied
  from public.catalog_systems system
  join public.catalog_system_stage_roles expectation
    on expectation.system_id = system.id
   and expectation.decision_status = 'approved'
   and expectation.is_active
  join public.catalog_stages stage on stage.id = expectation.stage_id and stage.is_active
  join public.catalog_roles role on role.id = expectation.role_id and role.is_active
  left join public.product_system_roles assignment
    on assignment.system_id = system.id
   and assignment.stage_id = stage.id
   and assignment.role_id = role.id
   and assignment.decision_status = 'approved'
  where system.code = upper(trim(p_system_code))
    and system.is_active
  group by
    stage.code, stage.name, stage.position,
    role.code, role.name,
    expectation.necessity, expectation.minimum_selections
  order by stage.position, role.name;
$function$;

create or replace function public.get_catalog_system_recommendations_v1(
  p_system_code text,
  p_product_ids uuid[] default '{}'::uuid[]
)
returns table (
  stage_code text,
  stage_name text,
  role_code text,
  role_name text,
  necessity text,
  product_id uuid,
  product_code text,
  product_name text,
  brand_name text,
  same_brand boolean,
  price_state text,
  displayed_price numeric,
  availability text,
  recommendation_reason text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with selected_brands as (
    select distinct product.brand_id
    from public.products product
    where product.id = any(coalesce(p_product_ids, '{}'::uuid[]))
  ), coverage as (
    select *
    from public.get_catalog_system_coverage_v1(p_system_code, p_product_ids)
    where not is_satisfied and minimum_selections > 0
  )
  select
    coverage.stage_code,
    coverage.stage_name,
    coverage.role_code,
    coverage.role_name,
    coverage.necessity,
    product.id,
    product.code,
    product.name,
    brand.name,
    exists (select 1 from selected_brands selected where selected.brand_id = product.brand_id),
    case
      when coalesce(nullif(projection.starting_price, 0), nullif(product.unit_price, 0)) is null then 'consult'
      else 'priced'
    end,
    coalesce(nullif(projection.starting_price, 0), nullif(product.unit_price, 0)),
    product.availability::text,
    case coverage.necessity
      when 'required' then 'Falta para completar el rol ' || coverage.role_name || ' del sistema.'
      else 'Recomendado para cubrir el rol ' || coverage.role_name || ' del sistema.'
    end
  from coverage
  join public.catalog_systems system on system.code = upper(trim(p_system_code))
  join public.catalog_stages stage
    on stage.system_id = system.id and stage.code = coverage.stage_code
  join public.catalog_roles role on role.code = coverage.role_code
  join public.product_system_roles assignment
    on assignment.system_id = system.id
   and assignment.stage_id = stage.id
   and assignment.role_id = role.id
   and assignment.decision_status = 'approved'
  join public.products product
    on product.id = assignment.product_id
   and product.is_active
   and not (product.id = any(coalesce(p_product_ids, '{}'::uuid[])))
  left join public.product_catalog_projection projection on projection.product_id = product.id
  join public.brands brand on brand.id = product.brand_id and brand.is_active
  order by
    case coverage.necessity when 'required' then 0 else 1 end,
    coverage.stage_code,
    10 desc,
    product.sort_order,
    product.name;
$function$;

grant execute on function public.get_catalog_system_coverage_v1(text, uuid[])
to anon, authenticated, service_role;
grant execute on function public.get_catalog_system_recommendations_v1(text, uuid[])
to anon, authenticated, service_role;

comment on table public.catalog_knowledge_gaps is
  'Preguntas de conocimiento accionables. Una brecha abierta impide inferir, no impide editar ni publicar el producto.';
comment on function public.get_catalog_system_recommendations_v1(text, uuid[]) is
  'Recomienda productos aprobados por rol faltante. Precio cero/nulo se devuelve como consult y nunca excluye el producto.';

commit;
