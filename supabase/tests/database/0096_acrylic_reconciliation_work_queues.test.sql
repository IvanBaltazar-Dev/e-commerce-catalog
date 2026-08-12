begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

select has_view(
  'public', 'catalog_acrylic_capture_queue_v1',
  '1 · existe la cola humana de las brechas Acrílico'
);
select has_view(
  'public', 'catalog_acrylic_variant_capture_queue_v1',
  '2 · existe la cola de tonos y fotografías por variante'
);
select has_view(
  'public', 'catalog_acrylic_compatibility_matrix_v1',
  '3 · existe la matriz de compatibilidad producto→producto'
);

select is(
  (select count(*)::integer
   from public.catalog_source_records record
   join public.catalog_sources source on source.id = record.source_id
   where source.source_key in (
     'mc-nails-official-acrylic',
     'acrylove-official-education',
     'masglo-official-acrylic'
   )
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
     )),
  9,
  '4 · nueve hallazgos oficiales quedan registrados como candidatos'
);

select results_eq(
  $$ select decision_status, metadata ->> 'requires_physical_label_match'
     from public.catalog_evidence_sets
     where evidence_key = 'ACRYLIC_OFFICIAL_IDENTITY_CANDIDATES' and version = 1 $$,
  $$ values ('proposed'::text, 'true'::text) $$,
  '5 · la evidencia permanece propuesta hasta reconciliar el envase'
);

select is(
  (select count(*)::integer
   from public.catalog_evidence_items item
   join public.catalog_evidence_sets evidence on evidence.id = item.evidence_set_id
   where evidence.evidence_key = 'ACRYLIC_OFFICIAL_IDENTITY_CANDIDATES'
     and evidence.version = 1),
  9,
  '6 · los nueve hallazgos están enlazados al conjunto propuesto'
);

select is(
  (select count(*)::integer from public.catalog_acrylic_capture_queue_v1),
  12,
  '7 · las doce brechas siguen visibles y accionables'
);

select is(
  (select count(*)::integer
   from public.catalog_acrylic_capture_queue_v1
   where priority = 'critical'),
  3,
  '8 · tres acciones continúan siendo críticas'
);

select is(
  (select count(*)::integer
   from public.catalog_acrylic_capture_queue_v1
   where price_required),
  0,
  '9 · ninguna captura exige precio'
);

select is(
  (select count(*)::integer from public.catalog_acrylic_variant_capture_queue_v1),
  81,
  '10 · la cola contiene las ochenta y una variantes de polvo'
);

select is(
  (select count(*)::integer
   from public.catalog_acrylic_variant_capture_queue_v1
   where needs_shade_reconciliation),
  81,
  '11 · las ochenta y una variantes aún necesitan tono homologado'
);

select is(
  (select count(*)::integer
   from public.catalog_acrylic_variant_capture_queue_v1
   where needs_variant_media),
  81,
  '12 · las ochenta y una variantes aún necesitan fotografía vinculada'
);

select is(
  (select count(*)::integer from public.catalog_acrylic_compatibility_matrix_v1),
  68,
  '13 · la matriz enumera diecisiete polvos por cuatro monómeros'
);

select is(
  (select count(*)::integer
   from public.catalog_acrylic_compatibility_matrix_v1
   where approved_relation_id is not null),
  0,
  '14 · la investigación no fabrica compatibilidades aprobadas'
);

select is(
  (select count(*)::integer
   from public.catalog_acrylic_compatibility_matrix_v1
   where price_required),
  0,
  '15 · la matriz de compatibilidad tampoco depende del precio'
);

select results_eq(
  $$ select metadata -> 'missing_number_in_current_feed'
     from public.catalog_knowledge_gaps
     where gap_key = 'ACRYLOVE_COVER_01_16_IDENTITY' $$,
  $$ values ('[8]'::jsonb) $$,
  '16 · la ausencia oficial del número 8 queda explícita, no rellenada'
);

select * from finish();

rollback;
