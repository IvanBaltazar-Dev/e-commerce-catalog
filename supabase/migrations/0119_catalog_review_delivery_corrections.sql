-- 0119 · Correcciones de entrega de la Mesa y saneamiento del catálogo local
--
-- 1. Una familia no puede usar el nombre de una variante como descripción.
-- 2. Una señal antigua no debe seguir preguntándose si una investigación
--    oficial posterior ya la sustituyó.
-- 3. Los productos DEMO pertenecen a los fixtures de prueba, no al catálogo
--    operativo reconstruido.

begin;

update public.products
set description = 'Familia de esmaltes tradicionales Admiss de 10 ml, organizada por tonos.',
    updated_at = now()
where code = 'ADM-ESM-CA6EEA'
  and public.search_normalize(description) = public.search_normalize('AJO Y LIMON');

update public.products
set description = 'Familia de esmaltes Masglo de 13.5 ml, organizada por tonos.',
    updated_at = now()
where code = 'MAS-ESM-4C95F3'
  and public.search_normalize(description) = public.search_normalize('ACTIVISTA');

-- El pipeline antiguo creó una comparación genérica por nombre. Si el
-- Universo de Referencia ya creó una candidata oficial para la misma ficha y
-- el mismo producto interno, la comparación antigua deja de ser una decisión
-- humana vigente. ZAC y Brillo tradicional quedan cubiertos por esta regla.
with duplicated_legacy as (
  select legacy.id
  from public.catalog_reconciliation_cases legacy
  where legacy.algorithm = 'official_product_name_and_code_v1'
    and legacy.status in ('proposed', 'needs_review')
    and nullif(legacy.evidence ->> 'official_url', '') is not null
    and exists (
      select 1
      from public.catalog_reconciliation_cases current_case
      left join public.catalog_reference_products reference_product
        on reference_product.id = current_case.reference_product_id
      left join public.catalog_reference_variants reference_variant
        on reference_variant.id = current_case.reference_variant_id
      where current_case.algorithm = 'official_identity_v1'
        and current_case.status in ('proposed', 'needs_review', 'approved')
        and current_case.product_id = legacy.product_id
        and coalesce(reference_product.source_url, reference_variant.source_url)
          = legacy.evidence ->> 'official_url'
    )
), retired_work as (
  update public.catalog_review_work_items work
  set status = 'superseded',
      resolution_code = 'official_research_superseded_legacy_match',
      resolution_payload = jsonb_build_object(
        'reason', 'La investigación oficial posterior sustituyó la comparación genérica por nombre.',
        'sourceCaseId', work.source_id
      ),
      resolved_at = now(),
      updated_at = now()
  where work.source_type = 'reconciliation_case'
    and work.source_id in (select id from duplicated_legacy)
    and work.status in ('open', 'in_progress')
  returning work.id
)
update public.catalog_reconciliation_cases reconciliation
set status = 'superseded',
    decided_at = coalesce(reconciliation.decided_at, now()),
    evidence = reconciliation.evidence || jsonb_build_object(
      'supersededReason', 'Sustituida por la candidata official_identity_v1 del Universo de Referencia.'
    ),
    updated_at = now()
where reconciliation.id in (select id from duplicated_legacy);

-- Los cinco productos de demostración se eliminan únicamente si no existe
-- actividad comercial real ligada a sus variantes. Inventario inicial demo y
-- relaciones demo sí se retiran porque fueron creados por el propio fixture.
create temporary table stage4_demo_products on commit drop as
select product.id
from public.products product
left join public.brands brand on brand.id = product.brand_id
where product.code like 'DEMO-%'
   or product.slug like 'demo-%'
   or brand.slug = 'demo-professional';

create temporary table stage4_demo_variants on commit drop as
select variant.id
from public.product_variants variant
where variant.product_id in (select id from stage4_demo_products);

create temporary table stage4_demo_candidates on commit drop as
select candidate.id
from public.catalog_relation_candidates candidate
where candidate.source_product_id in (select id from stage4_demo_products)
   or candidate.target_product_id in (select id from stage4_demo_products);

create temporary table stage4_demo_affected_runs on commit drop as
select distinct item.reprocess_run_id as id
from public.catalog_relation_reprocess_items item
where item.candidate_id in (select id from stage4_demo_candidates);

create temporary table stage4_demo_affected_decisions on commit drop as
select distinct item.decision_id as id
from public.catalog_relation_decision_items item
where item.candidate_id in (select id from stage4_demo_candidates);

do $cleanup_demo$
declare
  protected_references integer;
begin
  select
      (select count(*) from public.sale_lines where variant_id in (select id from stage4_demo_variants))
    + (select count(*) from public.return_lines where variant_id in (select id from stage4_demo_variants))
    + (select count(*) from public.goods_receipt_lines where variant_id in (select id from stage4_demo_variants))
    + (select count(*) from public.purchase_order_lines where variant_id in (select id from stage4_demo_variants))
    + (select count(*) from public.reservation_lines where variant_id in (select id from stage4_demo_variants))
    + (select count(*) from public.inventory_transfer_lines where variant_id in (select id from stage4_demo_variants))
    + (select count(*) from public.public_cart_items where variant_id in (select id from stage4_demo_variants))
    + (select count(*)
       from public.catalog_relation_decisions decision
       where decision.id in (select id from stage4_demo_affected_decisions)
         and decision.status in ('applied', 'rejected', 'adjustment_requested'))
  into protected_references;

  if protected_references > 0 then
    raise exception using
      errcode = '23503',
      message = 'No se retiraron productos DEMO porque tienen actividad comercial protegida.';
  end if;

  -- Las decisiones y previews contaminados todavía no fueron aplicados. Se
  -- cierran antes de retirar sus elementos congelados; sync creará después la
  -- versión correcta usando solamente productos del catálogo real.
  update public.catalog_relation_decision_previews preview
  set status = 'expired'
  where preview.decision_id in (select id from stage4_demo_affected_decisions)
    and preview.status = 'previewed';

  update public.catalog_review_work_items work
  set status = 'superseded',
      resolution_code = 'demo_fixture_removed',
      resolution_payload = jsonb_build_object(
        'reason', 'La decisión incluía productos de demostración retirados del catálogo operativo.'
      ),
      resolved_at = now(),
      updated_at = now()
  where work.source_type = 'relation_decision'
    and work.source_id in (select id from stage4_demo_affected_decisions)
    and work.status in ('open', 'in_progress');

  update public.catalog_relation_decisions decision
  set status = 'superseded',
      resolution_comment = 'Sustituida al retirar fixtures DEMO del conjunto afectado.',
      resolved_at = now(),
      updated_at = now()
  where decision.id in (select id from stage4_demo_affected_decisions)
    and decision.status = 'pending';

  update public.catalog_review_work_items work
  set status = 'superseded',
      resolution_code = 'demo_fixture_removed',
      resolution_payload = jsonb_build_object(
        'reason', 'La candidata pertenecía exclusivamente a datos de demostración.'
      ),
      resolved_at = now(),
      updated_at = now()
  where work.source_type = 'relation_candidate'
    and work.source_id in (select id from stage4_demo_candidates)
    and work.status in ('open', 'in_progress');

  -- Estas dos tablas son inmutables durante la operación normal. La excepción
  -- queda confinada a esta migración correctiva y a filas DEMO no aplicadas.
  alter table public.catalog_relation_decision_items
    disable trigger catalog_relation_decision_items_immutable;
  alter table public.catalog_relation_reprocess_items
    disable trigger catalog_relation_reprocess_items_immutable;

  delete from public.catalog_relation_decision_items
  where candidate_id in (select id from stage4_demo_candidates);

  delete from public.catalog_relation_reprocess_items
  where candidate_id in (select id from stage4_demo_candidates);

  alter table public.catalog_relation_reprocess_items
    enable trigger catalog_relation_reprocess_items_immutable;
  alter table public.catalog_relation_decision_items
    enable trigger catalog_relation_decision_items_immutable;

  delete from public.catalog_relation_candidates
  where id in (select id from stage4_demo_candidates);

  delete from public.inventory_valuation
  where variant_id in (select id from stage4_demo_variants);

  delete from public.inventory_stock
  where variant_id in (select id from stage4_demo_variants);

  delete from public.inventory_movements
  where variant_id in (select id from stage4_demo_variants);

  delete from public.initial_load_rows
  where variant_id in (select id from stage4_demo_variants);

  delete from public.wholesale_rules
  where product_id in (select id from stage4_demo_products)
     or variant_id in (select id from stage4_demo_variants);

  delete from public.product_relations
  where source_product_id in (select id from stage4_demo_products)
     or target_product_id in (select id from stage4_demo_products);

  delete from public.products
  where id in (select id from stage4_demo_products);

  -- Se vuelven a calcular las métricas y fingerprints de los dos previews
  -- históricos que habían congelado las mismas siete candidatas DEMO.
  update public.catalog_relation_reprocess_runs run
  set expected_candidate_count = (
        select count(*)::integer
        from public.catalog_relation_reprocess_items item
        where item.reprocess_run_id = run.id
      ),
      snapshot_fingerprint = public.catalog_relation_reprocess_state_fingerprint_v1(),
      preview_fingerprint = (
        select encode(extensions.digest(convert_to(coalesce(string_agg(
          concat_ws('|', item.ordinal, item.candidate_id, item.classification,
            item.epistemic_result, item.item_fingerprint), E'\n' order by item.ordinal
        ), ''), 'UTF8'), 'sha256'), 'hex')
        from public.catalog_relation_reprocess_items item
        where item.reprocess_run_id = run.id
      ),
      metrics = public.catalog_relation_reprocess_metrics_v1(run.id),
      metrics_after = public.catalog_relation_reprocess_metrics_v1(run.id)
        || (coalesce(run.metrics_after, '{}'::jsonb)
          - 'historicalCandidates' - 'classificationCounts' - 'classVsDirect'
          - 'epistemic' - 'guards')
  where run.id in (select id from stage4_demo_affected_runs);

  delete from public.media_assets media
  where (media.storage_path like 'demo/%' or media.metadata ->> 'demo' = 'true')
    and not exists (select 1 from public.product_media association where association.media_asset_id = media.id)
    and not exists (select 1 from public.brands brand where brand.logo_media_id = media.id);

  delete from public.brands
  where slug = 'demo-professional'
    and not exists (select 1 from public.products where brand_id = public.brands.id);
end;
$cleanup_demo$;

-- Si una decisión agrupada perdió elementos DEMO, se publica una versión
-- nueva con fingerprint y cantidades reales. Las decisiones sin cambios son
-- reutilizadas de manera idempotente.
select public.sync_catalog_relation_decisions_v1();

commit;
