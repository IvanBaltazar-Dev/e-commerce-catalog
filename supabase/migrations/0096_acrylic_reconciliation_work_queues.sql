-- ---------------------------------------------------------------------------
-- 0096 · Colas permanentes de reconciliación del sistema Acrílico
-- ---------------------------------------------------------------------------
-- La investigación oficial reduce incertidumbre, pero no convierte una
-- coincidencia comercial en compatibilidad técnica. Esta migración registra
-- candidatos oficiales, precisa las preguntas pendientes y expone tres colas
-- operativas: captura física, tonos/fotografías y matriz producto→producto.

begin;

with official_records(
  source_key, external_id, title, source_url, payload
) as (
  values
  (
    'mc-nails-official-acrylic',
    'anti-hongos-bliss',
    'Anti-Hongos BLISS',
    'https://mcnails.mx/products/anti-hongos-mc-bliss',
    $json${
      "official_sku":"MCAH",
      "claims":[
        "MC Nails publica el producto con el nombre Anti-Hongos BLISS.",
        "El nombre interno Deshidratador Mc Bliss contradice la función publicada y exige reconciliación por SKU o envase."
      ],
      "decision":"identity_candidate_only"
    }$json$::jsonb
  ),
  (
    'mc-nails-official-acrylic',
    'fantastic-liquid-16oz',
    'Líquido acrílico FANTASTIC LIQUID 16 oz',
    'https://mcnails.mx/products/liquido-acrilico-fantastic-liquid-16oz',
    $json${"official_sku":"MCLEX16","size":"16 oz","line":"FANTASTIC LIQUID","decision":"identity_candidate_only"}$json$::jsonb
  ),
  (
    'mc-nails-official-acrylic',
    'sens-4oz',
    'Líquido Acrílico Monómero SENS 4 oz',
    'https://mcnails.mx/products/liquido-acrilico-sens-4-oz',
    $json${"official_sku":"MCL4","size":"4 oz","line":"SENS","decision":"identity_candidate_only"}$json$::jsonb
  ),
  (
    'mc-nails-official-acrylic',
    'monarca-fragrance-4oz',
    'Monómero MONARCA FRAGANCE FLORAL 4 oz',
    'https://mcnails.mx/products/monomero-mc-monarca-fragance-floral-4-oz',
    $json${"official_sku":"MCMLA4","size":"4 oz","line":"MONARCA FRAGANCE FLORAL","decision":"identity_candidate_only"}$json$::jsonb
  ),
  (
    'acrylove-official-education',
    'beautiful-8',
    'PINCEL BEAUTIFUL #8',
    'https://acrylove.com/products/alpb8',
    $json${"official_sku":"ALPB8","model":"BEAUTIFUL #8","decision":"model_identity_only","acrylic_use_explicit_in_public_copy":false}$json$::jsonb
  ),
  (
    'acrylove-official-education',
    'beautiful-10',
    'PINCEL BEAUTIFUL #10',
    'https://acrylove.com/products/alpb10',
    $json${"official_sku":"ALPB10","model":"BEAUTIFUL #10","decision":"model_identity_only","acrylic_use_explicit_in_public_copy":false}$json$::jsonb
  ),
  (
    'acrylove-official-education',
    'makeup-catalog-2026-08-10',
    'Catálogo oficial AcryLove · serie MAKEUP 2 oz',
    'https://acrylove.com/products.json',
    $json${
      "official_sku_prefix":"ALMU",
      "published_numbers":[1,2,3,4,5,6,7,9,10,11,12,13,14,15,16],
      "missing_number_in_current_feed":[8],
      "finishes":{"1-4":"FAIRY DUST","5-10":"BRIGHT","11-16":"SOLID"},
      "internal_label_conflict":"El Excel dice Cover N.1–16; el catálogo actual dice MAKEUP y no publica el número 8.",
      "decision":"series_candidate_only"
    }$json$::jsonb
  ),
  (
    'masglo-official-acrylic',
    'monomer-120ml-2026',
    'MONÓMERO 120 ML MASGLO',
    'https://www.masglo.com/products/monomero-120-ml-masglo-1',
    $json${
      "official_sku":"313744",
      "size":"120 ml",
      "claims":["Líquido para moldear polvos acrílicos.","Masglo declara combinación con sus acrílicos.","Libre de MMA."],
      "decision":"official_product_confirmed_internal_identity_pending"
    }$json$::jsonb
  ),
  (
    'masglo-official-acrylic',
    'monomer-490ml-2026',
    'MONÓMERO 490 ML MASGLO',
    'https://www.masglo.com/products/monomero-490-ml-masglo',
    $json${
      "official_sku":"313530",
      "size":"490 ml",
      "claims":["Líquido para moldear polvos acrílicos.","Masglo declara combinación con sus acrílicos.","Libre de MMA."],
      "decision":"official_product_confirmed_internal_identity_pending"
    }$json$::jsonb
  )
), resolved_records as (
  select
    snapshot.id as snapshot_id,
    source.id as source_id,
    record.external_id,
    record.title,
    record.source_url,
    record.payload
  from official_records record
  join public.catalog_sources source on source.source_key = record.source_key
  join public.catalog_source_snapshots snapshot
    on snapshot.source_id = source.id
   and snapshot.content_hash = case
     when record.source_key in (
       'mc-nails-official-acrylic',
       'acrylove-official-education',
       'masglo-official-acrylic'
     ) then 'manual:2026-08-10:acrylic:v1'
   end
)
insert into public.catalog_source_records(
  snapshot_id, source_id, entity_type, external_id, title,
  normalized_name, source_url, payload, captured_at
)
select
  record.snapshot_id,
  record.source_id,
  'document',
  record.external_id,
  record.title,
  lower(record.title),
  record.source_url,
  record.payload,
  now()
from resolved_records record
on conflict (snapshot_id, entity_type, external_id) do update set
  title = excluded.title,
  normalized_name = excluded.normalized_name,
  source_url = excluded.source_url,
  payload = excluded.payload,
  captured_at = excluded.captured_at;

insert into public.catalog_evidence_sets(
  evidence_key, version, evidence_type, decision_status, confidence,
  rationale, metadata
)
values (
  'ACRYLIC_OFFICIAL_IDENTITY_CANDIDATES',
  1,
  'official_sources',
  'proposed',
  0.9000,
  'Las fuentes prueban productos y SKUs oficiales actuales, pero todavía no prueban que las filas internas sin SKU de fabricante sean esos mismos artículos.',
  $json${
    "scope":"identity_reconciliation",
    "may_create_product_compatibility":false,
    "requires_physical_label_match":true
  }$json$::jsonb
)
on conflict (evidence_key, version) do update set
  evidence_type = excluded.evidence_type,
  decision_status = excluded.decision_status,
  confidence = excluded.confidence,
  rationale = excluded.rationale,
  decided_by = null,
  decided_at = null,
  metadata = excluded.metadata;

insert into public.catalog_evidence_items(
  evidence_set_id, source_record_id, stance, notes
)
select
  evidence.id,
  record.id,
  'supports',
  'Candidato oficial para reconciliación; no promueve identidad interna ni compatibilidad.'
from public.catalog_evidence_sets evidence
join public.catalog_sources source
  on source.source_key in (
    'mc-nails-official-acrylic',
    'acrylove-official-education',
    'masglo-official-acrylic'
  )
join public.catalog_source_records record on record.source_id = source.id
where evidence.evidence_key = 'ACRYLIC_OFFICIAL_IDENTITY_CANDIDATES'
  and evidence.version = 1
  and record.external_id in (
    'anti-hongos-bliss',
    'fantastic-liquid-16oz',
    'sens-4oz',
    'monarca-fragrance-4oz',
    'beautiful-8',
    'beautiful-10',
    'makeup-catalog-2026-08-10',
    'monomer-120ml-2026',
    'monomer-490ml-2026'
  )
on conflict (evidence_set_id, source_record_id, stance)
where source_record_id is not null
do update set notes = excluded.notes;

update public.catalog_knowledge_gaps
set
  status = 'blocked_external',
  question = '¿El producto interno MCN-PRE-D7C129 corresponde al Anti-Hongos BLISS oficial SKU MCAH o es realmente otro deshidratador?',
  resolution_requirement = 'Fotografiar frente, reverso y código de barras/SKU. Si el envase dice MCAH o Anti-Hongos, reconciliar la identidad y no asignarlo como deshidratador.',
  metadata = metadata || $json${
    "official_candidate":{"name":"Anti-Hongos BLISS","sku":"MCAH","url":"https://mcnails.mx/products/anti-hongos-mc-bliss"},
    "internal_label":"Deshidratador Mc Bliss",
    "identity_conflict":true,
    "required_photos":["front","back","barcode_or_sku"]
  }$json$::jsonb
where gap_key = 'MC_NAILS_BLISS_FUNCTION';

update public.catalog_knowledge_gaps
set
  status = 'blocked_external',
  resolution_requirement = 'Para el envase de 16 oz: frente, reverso, SKU y línea; candidato oficial FANTASTIC LIQUID MCLEX16. Para el envase de 4 oz con olor: las mismas fotos; candidatos SENS MCL4 y MONARCA FRAGANCE FLORAL MCMLA4. Adjuntar ingredientes/SDS si aparecen.',
  metadata = metadata || $json${
    "official_candidates_16oz":[{"line":"FANTASTIC LIQUID","sku":"MCLEX16","url":"https://mcnails.mx/products/liquido-acrilico-fantastic-liquid-16oz"}],
    "official_candidates_4oz":[
      {"line":"SENS","sku":"MCL4","url":"https://mcnails.mx/products/liquido-acrilico-sens-4-oz"},
      {"line":"MONARCA FRAGANCE FLORAL","sku":"MCMLA4","url":"https://mcnails.mx/products/monomero-mc-monarca-fragance-floral-4-oz"}
    ],
    "required_photos":["front","back","barcode_or_sku","ingredients_and_warnings"]
  }$json$::jsonb
where gap_key = 'MC_NAILS_MONOMER_LINE_IDENTITY';

update public.catalog_knowledge_gaps
set
  status = 'blocked_external',
  question = '¿Las variantes internas Cover N.1–16 corresponden a la serie oficial MAKEUP ALMU, a la serie 2020 ALAM o a otra línea impresa?',
  resolution_requirement = 'Fotografiar primero N.1, N.8 y N.16: frente, base/tapa con número, reverso y SKU. La serie oficial actual publica ALMU1–ALMU7 y ALMU9–ALMU16; no publica ALMU8, por lo que el número solo no basta.',
  metadata = metadata || $json${
    "official_series":"MAKEUP 2 oz",
    "official_sku_prefix":"ALMU",
    "published_numbers":[1,2,3,4,5,6,7,9,10,11,12,13,14,15,16],
    "missing_number_in_current_feed":[8],
    "pilot_variants":["Cover N.1 2oz","Cover N.8 2oz","Cover N.16 2oz"],
    "must_match_physical_sku":true
  }$json$::jsonb
where gap_key = 'ACRYLOVE_COVER_01_16_IDENTITY';

update public.catalog_knowledge_gaps
set
  status = 'blocked_external',
  resolution_requirement = 'La tienda oficial confirma los modelos Beautiful #8 SKU ALPB8 y #10 SKU ALPB10, pero su texto público no declara el uso técnico. Fotografiar envase/estuche o aportar catálogo oficial que diga explícitamente uso en Acrílico.',
  metadata = metadata || $json${
    "official_models":[
      {"model":"BEAUTIFUL #8","sku":"ALPB8","url":"https://acrylove.com/products/alpb8"},
      {"model":"BEAUTIFUL #10","sku":"ALPB10","url":"https://acrylove.com/products/alpb10"}
    ],
    "model_identity_confirmed":true,
    "acrylic_use_still_unproven":true
  }$json$::jsonb
where gap_key = 'ACRYLOVE_BEAUTIFUL_BRUSH_USE';

update public.catalog_knowledge_gaps
set
  status = 'blocked_external',
  resolution_requirement = 'Masglo publica monómeros 120 ml SKU 313744 y 490 ml SKU 313530 y declara su uso con acrílicos Masglo. Reconciliar contra inventario mediante foto del SKU/envase; no sustituir Ultrabond por monómero.',
  metadata = metadata || $json${
    "official_monomers":[
      {"size":"120 ml","sku":"313744","url":"https://www.masglo.com/products/monomero-120-ml-masglo-1"},
      {"size":"490 ml","sku":"313530","url":"https://www.masglo.com/products/monomero-490-ml-masglo"}
    ],
    "ultrabond_is_separate_official_sku":true,
    "requires_internal_inventory_match":true
  }$json$::jsonb
where gap_key = 'MASGLO_MONOMER_CATALOG_COVERAGE';

update public.catalog_knowledge_gaps
set
  status = 'blocked_external',
  resolution_requirement = 'Fotografiar frente y reverso del SKU 330247 y obtener manual/ficha técnica. La página pública solo lo nombra Líquido Acrílico Ultrabond; no explica si es adherente, primer, balanceador u otra función.',
  metadata = metadata || $json${
    "official_sku":"330247",
    "official_public_copy_has_exact_function":false,
    "required_photos":["front","back","barcode_or_sku","instructions"]
  }$json$::jsonb
where gap_key = 'MASGLO_ULTRABOND_EXACT_FUNCTION';

create or replace view public.catalog_acrylic_capture_queue_v1
with (security_invoker = true) as
select
  gap.id,
  gap.gap_key,
  case gap.priority
    when 'critical' then 1
    when 'high' then 2
    when 'medium' then 3
    else 4
  end as priority_order,
  gap.priority,
  gap.status,
  gap.gap_type,
  product.code as product_code,
  product.name as product_name,
  class.code as class_code,
  gap.title,
  gap.question,
  gap.resolution_requirement as human_action,
  case
    when gap.gap_type in ('formulation', 'safety') then 'label_plus_sds'
    when gap.gap_type in ('compatibility', 'incompatibility') then 'manufacturer_pair_evidence'
    when gap.gap_type = 'identity' then 'physical_packaging'
    when gap.gap_type = 'membership' then 'packaging_or_official_manual'
    when gap.gap_type = 'media' then 'variant_photography'
    else 'official_catalog_or_packaging'
  end as input_needed,
  false as price_required,
  gap.metadata,
  gap.updated_at
from public.catalog_knowledge_gaps gap
join public.catalog_systems system
  on system.id = gap.system_id and system.code = 'ACRYLIC'
left join public.products product on product.id = gap.product_id
left join public.catalog_classes class on class.id = gap.class_id
where gap.status in ('open', 'in_progress', 'blocked_external');

create or replace view public.catalog_acrylic_variant_capture_queue_v1
with (security_invoker = true) as
select
  variant.id as variant_id,
  variant.sku,
  brand.name as brand_name,
  product.id as product_id,
  product.code as product_code,
  product.name as product_name,
  variant.name as variant_name,
  variant.variant_key,
  variant.color_shade_id,
  coalesce(media.media_count, 0)::integer as variant_media_count,
  variant.color_shade_id is null as needs_shade_reconciliation,
  coalesce(media.media_count, 0) = 0 as needs_variant_media,
  array_remove(array[
    case when variant.color_shade_id is null then 'shade'::text end,
    case when coalesce(media.media_count, 0) = 0 then 'variant_media'::text end
  ], null) as missing_components,
  case
    when upper(brand.name) = 'ACRYLOVE'
      and (variant.name ~* 'cover[[:space:]]*n?[.]?[[:space:]]*(1|8|16)([^0-9]|$)'
        or product.name ~* 'makeup')
      then 'high'
    else 'medium'
  end as capture_priority,
  case
    when variant.color_shade_id is null and coalesce(media.media_count, 0) = 0
      then 'Fotografiar frente, reverso y muestra aplicada; transcribir tono y acabado impresos.'
    when variant.color_shade_id is null
      then 'Transcribir tono y acabado impresos y homologar el color.'
    when coalesce(media.media_count, 0) = 0
      then 'Fotografiar la variante y vincular la imagen a la variante, no solo al producto.'
    else 'Sin acción pendiente.'
  end as recommended_action,
  false as price_required
from public.catalog_class_members membership
join public.catalog_classes class
  on class.id = membership.class_id and class.code = 'ACRYLIC_POLYMER'
join public.products product on product.id = membership.product_id
join public.brands brand on brand.id = product.brand_id
join public.product_variants variant
  on variant.product_id = product.id and variant.is_active
left join lateral (
  select count(*) as media_count
  from public.product_media media
  where media.variant_id = variant.id
) media on true
where membership.decision_status = 'approved';

create or replace view public.catalog_acrylic_compatibility_matrix_v1
with (security_invoker = true) as
with polymers as (
  select product.id, product.code, product.name, product.brand_id, brand.name as brand_name
  from public.catalog_class_members membership
  join public.catalog_classes class
    on class.id = membership.class_id and class.code = 'ACRYLIC_POLYMER'
  join public.products product on product.id = membership.product_id
  join public.brands brand on brand.id = product.brand_id
  where membership.decision_status = 'approved'
), monomers as (
  select product.id, product.code, product.name, product.brand_id, brand.name as brand_name
  from public.catalog_class_members membership
  join public.catalog_classes class
    on class.id = membership.class_id and class.code = 'ACRYLIC_MONOMER'
  join public.products product on product.id = membership.product_id
  join public.brands brand on brand.id = product.brand_id
  where membership.decision_status = 'approved'
)
select
  polymer.code || '→' || monomer.code as pair_key,
  polymer.id as polymer_product_id,
  polymer.code as polymer_code,
  polymer.name as polymer_name,
  polymer.brand_name as polymer_brand,
  monomer.id as monomer_product_id,
  monomer.code as monomer_code,
  monomer.name as monomer_name,
  monomer.brand_name as monomer_brand,
  polymer.brand_id = monomer.brand_id as same_brand,
  relation.id as approved_relation_id,
  relation.evidence_set_id,
  coalesce(relation.compatibility_status::text, 'needs_evidence') as pair_status,
  case
    when relation.id is not null then 'Usar la evidencia aprobada de la relación.'
    when polymer.brand_id = monomer.brand_id then 'Priorizar validación: obtener instrucción oficial o SDS que nombre la línea de polvo y el monómero.'
    else 'No recomendar: se necesita evidencia explícita del fabricante para esta pareja entre marcas.'
  end as recommended_next_action,
  false as price_required
from polymers polymer
cross join monomers monomer
left join lateral (
  select candidate.id, candidate.evidence_set_id, candidate.compatibility_status
  from public.product_relations candidate
  where candidate.is_active
    and candidate.knowledge_status = 'approved'
    and candidate.relation_type in ('requires', 'compatible_with', 'recommended_with')
    and (
      (candidate.source_product_id = polymer.id and candidate.target_product_id = monomer.id)
      or (candidate.source_product_id = monomer.id and candidate.target_product_id = polymer.id)
    )
  order by case candidate.compatibility_status
    when 'confirmed' then 1
    when 'conditional' then 2
    else 3
  end, candidate.created_at desc
  limit 1
) relation on true;

grant select on public.catalog_acrylic_capture_queue_v1
to authenticated, service_role;
grant select on public.catalog_acrylic_variant_capture_queue_v1
to authenticated, service_role;
grant select on public.catalog_acrylic_compatibility_matrix_v1
to authenticated, service_role;

commit;
