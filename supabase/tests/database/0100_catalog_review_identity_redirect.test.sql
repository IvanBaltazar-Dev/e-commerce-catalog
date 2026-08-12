begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

select has_function(
  'public', 'create_catalog_review_identity_redirect_v1', array[]::text[],
  '1 · existe la proyección trazable de un rechazo de identidad'
);

select is(
  (select reconciliation.entity_type
   from public.catalog_reconciliation_cases reconciliation
   join public.catalog_source_records record on record.id = reconciliation.source_record_id
   where record.source_url = 'https://masglo.com.es/products/esmalte-para-unas-ausente-13-5ml-264'
     and reconciliation.algorithm = 'official_product_name_and_code_v1'),
  'variant',
  '2 · AUSENTE se compara contra una variante, no contra 164 variantes del producto base'
);

select is(
  (select variant.sku
   from public.catalog_reconciliation_cases reconciliation
   join public.catalog_source_records record on record.id = reconciliation.source_record_id
   join public.product_variants variant on variant.id = reconciliation.variant_id
   where record.source_url = 'https://masglo.com.es/products/esmalte-para-unas-ausente-13-5ml-264'
     and reconciliation.algorithm = 'official_product_name_and_code_v1'),
  'MAS022',
  '3 · la entidad interna exacta conserva el código original MAS022'
);

select is(
  (select (reconciliation.evidence -> 'internal_source' ->> 'row_number')::integer
   from public.catalog_reconciliation_cases reconciliation
   where reconciliation.algorithm = 'official_product_name_and_code_v1'
     and reconciliation.variant_id = (select id from public.product_variants where sku = 'MAS022')),
  972,
  '4 · la decisión conserva la fila exacta del Excel normalizado'
);

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  'a1000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'redirect-admin@example.invalid', '', now(),
  '{}', '{}', now(), now(), '', '', '', ''
);

insert into public.admin_profiles(id, role, full_name, is_active)
values ('a1000000-0000-4000-8000-000000000001', 'admin', 'Administradora de redirección', true);

create temporary table redirect_fx as
select
  item.id as work_item_id,
  item.row_version,
  reconciliation.id as reconciliation_id,
  reconciliation.source_record_id,
  (
    select product.id
    from public.products product
    where product.is_active
      and product.id <> variant.product_id
    order by product.id
    limit 1
  ) as target_product_id
from public.catalog_reconciliation_cases reconciliation
join public.product_variants variant on variant.id = reconciliation.variant_id
join public.catalog_review_work_items item
  on item.source_type = 'reconciliation_case'
 and item.source_id = reconciliation.id
 and item.status = 'open'
where variant.sku = 'MAS022'
  and reconciliation.algorithm = 'official_product_name_and_code_v1';

set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format(
    $sql$ select public.resolve_catalog_review_item_v1(
      %L::uuid, %s, 'reject',
      jsonb_build_object(
        'reason', 'La etiqueta y el código corresponden a otro registro.',
        'placement', jsonb_build_object(
          'target', jsonb_build_object(
            'entityType', 'product',
            'entityId', %L::uuid,
            'name', 'Destino de prueba'
          ),
          'referenceUrl', 'https://example.invalid/ficha-correcta',
          'imagePath', 'products/review/reference.webp',
          'notes', 'Código visible en la base del envase.'
        )
      ),
      '[{"id":"reviewer-redirect-reference","kind":"reviewer_reference"}]'::jsonb,
      'pgtap-identity-redirect', null
    ) $sql$,
    (select work_item_id from redirect_fx),
    (select row_version from redirect_fx),
    (select target_product_id from redirect_fx)
  ),
  '5 · rechazar con un destino aplica en una sola transacción'
);

select is(
  (select status from public.catalog_reconciliation_cases where id = (select reconciliation_id from redirect_fx)),
  'rejected',
  '6 · la pareja incorrecta queda cerrada'
);

select is(
  (select status
   from public.catalog_reconciliation_cases
   where source_record_id = (select source_record_id from redirect_fx)
     and product_id = (select target_product_id from redirect_fx)
     and algorithm = 'human_redirect_candidate_v1'),
  'needs_review',
  '7 · el destino sugerido se convierte en candidata, nunca en aprobación automática'
);

select is(
  (select queue.queue_state
   from public.catalog_review_operational_queue_v1 queue
   join public.catalog_reconciliation_cases reconciliation on reconciliation.id = queue.source_id
   where reconciliation.source_record_id = (select source_record_id from redirect_fx)
     and reconciliation.product_id = (select target_product_id from redirect_fx)
     and reconciliation.algorithm = 'human_redirect_candidate_v1'),
  'reviewable',
  '8 · la nueva candidata queda disponible para revisión posterior'
);

select is(
  (select event.payload -> 'placement' ->> 'referenceUrl'
   from public.catalog_review_events event
   where event.idempotency_key = 'pgtap-identity-redirect'),
  'https://example.invalid/ficha-correcta',
  '9 · el enlace aportado queda en el evento inmutable'
);

select is(
  (select event.payload -> 'placement' ->> 'imagePath'
   from public.catalog_review_events event
   where event.idempotency_key = 'pgtap-identity-redirect'),
  'products/review/reference.webp',
  '10 · la foto de referencia queda trazable sin asociarse al producto equivocado'
);

select * from finish();
rollback;
