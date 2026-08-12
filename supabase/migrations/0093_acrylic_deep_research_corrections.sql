-- ---------------------------------------------------------------------------
-- 0093 · Correcciones de la revisión profunda del vertical Acrílico
-- ---------------------------------------------------------------------------
-- Una publicación dentro de una colección Acrílico no demuestra por sí sola
-- el rol técnico exacto. Esta migración retira tres asignaciones demasiado
-- amplias, conserva la ambigüedad como deuda accionable y fortalece la
-- evidencia del pincel Cherimoya #10.

begin;

-- La ficha oficial de Ultrabond declara el nombre y su pertenencia al catálogo
-- Acrílico, pero no explica su función. El catálogo oficial presenta además un
-- producto separado llamado Monómero 120 ml. Ninguno de esos dos hechos permite
-- promover Ultrabond a primer/adherente sin manual, envase o ficha técnica.
update public.catalog_source_records record
set
  title = 'LÍQUIDO ACRÍLICO MASGLO ULTRABOND 7 ML',
  normalized_name = lower('LÍQUIDO ACRÍLICO MASGLO ULTRABOND 7 ML'),
  source_url = 'https://www.masglo.com/products/liquido-para-unas-en-acrilico-ultrabond',
  payload = $json${
    "claims":[
      "Masglo publica Ultrabond 7 ml dentro de su catálogo de Acrílicos.",
      "La ficha pública no explica si su función es primer, adherente, balanceador u otro líquido de proceso.",
      "La función exacta no debe inferirse a partir de la palabra Ultrabond ni de la categoría interna de Bellaroshé."
    ],
    "decision":"insufficient_for_exact_role"
  }$json$::jsonb,
  captured_at = now()
from public.catalog_sources source
where record.source_id = source.id
  and source.source_key = 'masglo-official-acrylic'
  and record.external_id = 'ultrabond-7ml';

with masglo_snapshot as (
  select snapshot.id, snapshot.source_id
  from public.catalog_source_snapshots snapshot
  join public.catalog_sources source on source.id = snapshot.source_id
  where source.source_key = 'masglo-official-acrylic'
    and snapshot.content_hash = 'manual:2026-08-10:acrylic:v1'
), documents(external_id, title, source_url, payload) as (
  values
  (
    'acrylic-collection-2026',
    'Masglo · colección oficial Acrílicos',
    'https://www.masglo.com/collections/unas-en-acrilico-gel-esmaltes-lamparas-dilusor-removedor-polvos-acrilicos',
    $json${
      "claims":[
        "La colección oficial lista Monómero 120 ml y Ultrabond 7 ml como productos separados.",
        "La separación de catálogo descarta tratarlos como el mismo SKU, pero no define por sí sola el rol de Ultrabond."
      ]
    }$json$::jsonb
  ),
  (
    'kolinsky-10',
    'Cherimoya Pincel Kolinsky #10',
    'https://cherimoya.pe/producto/pincel-kolinsky-8-10/',
    $json${
      "claims":[
        "Cherimoya incluye el pincel Kolinsky #10 en las categorías Pinceles para Acrílico y Acrílico.",
        "La página identifica la marca, el modelo #10 y el material del pincel."
      ]
    }$json$::jsonb
  )
)
insert into public.catalog_source_records(
  snapshot_id, source_id, entity_type, external_id, title,
  normalized_name, source_url, payload, captured_at
)
select
  case
    when document.external_id = 'kolinsky-10' then cherimoya_snapshot.id
    else masglo_snapshot.id
  end,
  case
    when document.external_id = 'kolinsky-10' then cherimoya_snapshot.source_id
    else masglo_snapshot.source_id
  end,
  'document',
  document.external_id,
  document.title,
  lower(document.title),
  document.source_url,
  document.payload,
  now()
from documents document
cross join masglo_snapshot
cross join lateral (
  select snapshot.id, snapshot.source_id
  from public.catalog_source_snapshots snapshot
  join public.catalog_sources source on source.id = snapshot.source_id
  where source.source_key = 'cherimoya-official-acrylic'
    and snapshot.content_hash = 'manual:2026-08-10:acrylic:v1'
) cherimoya_snapshot
on conflict (snapshot_id, entity_type, external_id) do update set
  title = excluded.title,
  normalized_name = excluded.normalized_name,
  source_url = excluded.source_url,
  payload = excluded.payload,
  captured_at = excluded.captured_at;

-- Ultrabond deja de respaldar el conjunto de preparadores hasta conocer su rol.
delete from public.catalog_evidence_items item
using public.catalog_evidence_sets evidence,
      public.catalog_source_records record,
      public.catalog_sources source
where item.evidence_set_id = evidence.id
  and item.source_record_id = record.id
  and record.source_id = source.id
  and evidence.evidence_key = 'ACRYLIC_PREPARATION_PRODUCTS'
  and evidence.version = 1
  and source.source_key = 'masglo-official-acrylic'
  and record.external_id = 'ultrabond-7ml';

-- El #10 sí queda respaldado de forma directa por la página oficial Cherimoya.
insert into public.catalog_evidence_items(
  evidence_set_id, source_record_id, stance, notes
)
select
  evidence.id,
  record.id,
  'supports',
  'La página oficial clasifica el modelo #10 como pincel para Acrílico.'
from public.catalog_evidence_sets evidence
join public.catalog_sources source on source.source_key = 'cherimoya-official-acrylic'
join public.catalog_source_records record
  on record.source_id = source.id and record.external_id = 'kolinsky-10'
where evidence.evidence_key = 'ACRYLIC_APPLICATION_TOOLS'
  and evidence.version = 1
on conflict (evidence_set_id, source_record_id, stance)
where source_record_id is not null
do update set
  notes = excluded.notes;

-- Primero se corrigen las candidatas que apuntaban a Ultrabond para liberar la
-- FK hacia el rol promovido. La evidencia automática se mantiene y se anexa la
-- razón de la rectificación.
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
    'decision_reason', 'La ficha oficial de Ultrabond no demuestra su rol técnico exacto dentro del flujo Acrílico.',
    'corrected_by_migration', '0093_acrylic_deep_research_corrections'
  )
from public.products target
where candidate.target_product_id = target.id
  and target.code = 'MAS-PRE-C83A0D'
  and candidate.rule_code = 'acrylic_powder->primer';

delete from public.product_system_roles assignment
using public.products product,
      public.catalog_systems system
where assignment.product_id = product.id
  and assignment.system_id = system.id
  and system.code = 'ACRYLIC'
  and product.code in (
    'MAS-PRE-C83A0D',
    'ACR-PIN-5C586F',
    'ACR-PIN-D16329'
  );

delete from public.catalog_class_members membership
using public.products product,
      public.catalog_classes class
where membership.product_id = product.id
  and membership.class_id = class.id
  and (
    (product.code = 'MAS-PRE-C83A0D' and class.code = 'ACRYLIC_PRIMER')
    or (
      product.code in ('ACR-PIN-5C586F', 'ACR-PIN-D16329')
      and class.code = 'ACRYLIC_BRUSH'
    )
  );

-- El clasificador corregido solo convierte a rol aquello cuyo uso exacto fue
-- demostrado. Ultrabond y cualquier otro preparador ambiguo terminan en la
-- rama de evidencia insuficiente.
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
      'ACR-PRE-1C3A18', 'ACR-PRE-3FBDDC',
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
      'decision_reason', 'El nombre, la categoría o la marca no prueban el rol exacto; se requiere envase, manual o ficha técnica.'
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

with acrylic as (
  select id from public.catalog_systems where code = 'ACRYLIC'
), gaps(gap_key, product_code, class_code, gap_type, priority, status, title, question, requirement, metadata) as (
  values
  (
    'MASGLO_ULTRABOND_EXACT_FUNCTION',
    'MAS-PRE-C83A0D',
    null::text,
    'membership',
    'high',
    'blocked_external',
    'Función exacta de Masglo Ultrabond no demostrada',
    '¿Ultrabond 7 ml es primer, adherente, balanceador u otro líquido del sistema Acrílico?',
    'Foto legible de frente y reverso, SKU 330247 y manual/ficha técnica oficial que describa su uso y posición en el proceso.',
    $json${
      "official_product_url":"https://www.masglo.com/products/liquido-para-unas-en-acrilico-ultrabond",
      "official_collection_url":"https://www.masglo.com/collections/unas-en-acrilico-gel-esmaltes-lamparas-dilusor-removedor-polvos-acrilicos",
      "must_not_assign_role_until_resolved":true
    }$json$::jsonb
  ),
  (
    'ACRYLOVE_BEAUTIFUL_BRUSH_USE',
    null::text,
    'ACRYLIC_BRUSH',
    'membership',
    'medium',
    'blocked_external',
    'Uso Acrílico de la línea Beautiful no demostrado',
    '¿Los pinceles AcryLove Beautiful Kolinsky #8 y #10 están declarados específicamente para aplicación de Acrílico?',
    'Foto frontal y posterior de ambos envases o página/catálogo oficial que nombre la línea, el número y el uso Acrílico.',
    $json${
      "product_codes":["ACR-PIN-D16329","ACR-PIN-5C586F"],
      "do_not_infer_from":["kolinsky","brand","category"]
    }$json$::jsonb
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
  metadata = excluded.metadata,
  resolved_evidence_set_id = null,
  decided_by = null,
  resolved_at = null;

commit;
