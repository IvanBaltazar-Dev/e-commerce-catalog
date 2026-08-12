-- ---------------------------------------------------------------------------
-- 0100 · Alcance exacto y redirección trazable de identidad
-- ---------------------------------------------------------------------------
-- Un rechazo de identidad no debe perder la ficha externa ni convertir una
-- sugerencia humana en una relación aprobada. Conserva referencias y, cuando
-- existe un destino concreto, crea una nueva candidata separada para revisar.

begin;

create or replace function public.create_catalog_review_identity_redirect_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  origin_item public.catalog_review_work_items%rowtype;
  origin_case public.catalog_reconciliation_cases%rowtype;
  placement jsonb := coalesce(new.payload -> 'placement', '{}'::jsonb);
  target jsonb;
  target_type text;
  target_id uuid;
  target_exists boolean := false;
  redirected_case_id uuid;
  source_title text;
begin
  if new.event_type <> 'decision_taken' or new.action_code <> 'reject' then
    return new;
  end if;

  select * into origin_item
  from public.catalog_review_work_items
  where id = new.work_item_id and source_type = 'reconciliation_case';
  if not found then return new; end if;

  select * into origin_case
  from public.catalog_reconciliation_cases
  where id = origin_item.source_id;
  if not found then return new; end if;

  select record.title into source_title
  from public.catalog_source_records record
  where record.id = origin_case.source_record_id;

  target := coalesce(placement -> 'target', '{}'::jsonb);
  target_type := nullif(trim(coalesce(target ->> 'entityType', '')), '');

  if nullif(trim(coalesce(target ->> 'entityId', '')), '') is not null then
    begin
      target_id := (target ->> 'entityId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'El destino sugerido no tiene un identificador válido.';
    end;

    if target_type = 'product' then
      select exists(select 1 from public.products where id = target_id and is_active) into target_exists;
    elsif target_type = 'variant' then
      select exists(select 1 from public.product_variants where id = target_id and is_active) into target_exists;
    else
      raise exception using errcode = '22023', message = 'El destino debe ser un producto o una variante.';
    end if;

    if not target_exists then
      raise exception using errcode = '22023', message = 'El destino sugerido ya no está disponible en el catálogo.';
    end if;
    if (target_type = origin_case.entity_type)
       and ((target_type = 'product' and target_id = origin_case.product_id)
         or (target_type = 'variant' and target_id = origin_case.variant_id)) then
      raise exception using errcode = '22023', message = 'El nuevo destino no puede ser el mismo registro que acabas de rechazar.';
    end if;

    select candidate.id into redirected_case_id
    from public.catalog_reconciliation_cases candidate
    where candidate.source_record_id = origin_case.source_record_id
      and candidate.entity_type = target_type
      and ((target_type = 'product' and candidate.product_id = target_id)
        or (target_type = 'variant' and candidate.variant_id = target_id))
      and candidate.status in ('proposed', 'needs_review', 'approved')
    order by candidate.created_at desc
    limit 1;

    if redirected_case_id is null then
      insert into public.catalog_reconciliation_cases(
        entity_type, product_id, variant_id, shade_id, source_record_id,
        algorithm, score, status, evidence
      ) values (
        target_type,
        case when target_type = 'product' then target_id end,
        case when target_type = 'variant' then target_id end,
        null,
        origin_case.source_record_id,
        'human_redirect_candidate_v1',
        0.65000,
        'needs_review',
        (origin_case.evidence
          - 'internal_code' - 'internal_name' - 'internal_source'
          - 'candidate_2' - 'candidate_2_score' - 'candidate_3' - 'candidate_3_score')
        || jsonb_build_object(
          'ambiguous', true,
          'redirected_from_case_id', origin_case.id,
          'redirected_from_subject_type', origin_item.subject_type,
          'redirected_from_subject_id', origin_item.subject_id,
          'reviewer_reason', new.payload ->> 'reason',
          'reviewer_placement', placement,
          'redirect_event_id', new.id
        )
      ) returning id into redirected_case_id;
    end if;

    perform public.sync_catalog_review_work_items_v1();
    return new;
  end if;

  -- Sin destino exacto no se inventa una relación. La pista queda visible como
  -- trabajo en espera y conserva foto, URL, texto libre y la ficha rechazada.
  perform public.register_catalog_review_work_item_v1(
    'manual:source-record:' || origin_case.source_record_id::text || ':identity-placement',
    'manual', null, 'waiting_external', 'identity',
    'source_record', origin_case.source_record_id,
    md5(jsonb_build_object('payload', new.payload, 'evidence', new.evidence)::text),
    '¿A qué producto o variante pertenece este registro externo?',
    'Usa las referencias del rechazo para encontrar un destino verificable; no confirmes por parecido.',
    'manual:identity-placement', 'normal', 'normal', true, 1, 0, 2,
    jsonb_build_object(
      'title', coalesce(source_title, 'Registro externo sin ubicar'),
      'originWorkItemId', origin_item.id,
      'originReconciliationCaseId', origin_case.id,
      'sourceRecordId', origin_case.source_record_id,
      'placement', placement,
      'reviewerReason', new.payload ->> 'reason',
      'evidence', new.evidence
    )
  );
  return new;
end;
$function$;

create trigger catalog_review_identity_redirect
after insert on public.catalog_review_events
for each row execute function public.create_catalog_review_identity_redirect_v1();

revoke execute on function public.create_catalog_review_identity_redirect_v1()
from public, anon, authenticated;

-- El único caso Masglo activo compara una ficha oficial de tono con el
-- producto base completo. Se corrige a la variante exacta y se conserva la
-- fila 972 del Excel normalizado como evidencia legible, no como dato inferido.
do $migration$
declare
  reconciliation_id uuid;
  ausente_variant_id uuid;
  old_item public.catalog_review_work_items%rowtype;
  changed_item public.catalog_review_work_items%rowtype;
begin
  select reconciliation.id, variant.id
  into reconciliation_id, ausente_variant_id
  from public.catalog_reconciliation_cases reconciliation
  join public.catalog_source_records record on record.id = reconciliation.source_record_id
  join public.products product on product.id = reconciliation.product_id
  join public.product_variants variant
    on variant.product_id = product.id and lower(variant.sku) = lower('MAS022')
  where product.code = 'MAS-ESM-4C95F3'
    and record.source_url = 'https://masglo.com.es/products/esmalte-para-unas-ausente-13-5ml-264'
    and reconciliation.status in ('proposed', 'needs_review')
  limit 1;

  if reconciliation_id is null or ausente_variant_id is null then return; end if;

  select * into old_item
  from public.catalog_review_work_items
  where source_type = 'reconciliation_case'
    and source_id = reconciliation_id
    and status in ('open', 'in_progress')
  for update;

  if found then
    update public.catalog_review_work_items
    set status = 'superseded',
        resolution_code = 'identity_scope_corrected',
        resolution_payload = jsonb_build_object(
          'reason', 'La fuente oficial identifica la variante Ausente, no el producto base completo.',
          'correctVariantId', ausente_variant_id
        ),
        resolved_at = now()
    where id = old_item.id
    returning * into changed_item;

    insert into public.catalog_review_events(
      work_item_id, work_key, event_type, action_code,
      idempotency_key, request_fingerprint, prior_version, new_version, payload
    ) values (
      changed_item.id, changed_item.work_key, 'decision_superseded', 'identity_scope_corrected',
      'system:identity-scope-corrected:' || changed_item.id::text,
      md5('identity-scope-corrected:' || changed_item.id::text),
      old_item.row_version, changed_item.row_version, changed_item.resolution_payload
    ) on conflict (idempotency_key) do nothing;
  end if;

  update public.catalog_reconciliation_cases
  set entity_type = 'variant',
      product_id = null,
      variant_id = ausente_variant_id,
      evidence = evidence || jsonb_build_object(
        'internal_source', jsonb_build_object(
          'file_name', 'Listado_organizado_productos_Bellaroshe.xlsx',
          'sheet', 'Catálogo organizado',
          'row_number', 972,
          'fields', jsonb_build_object(
            'proposed_category', 'Uñas, manicure y pedicure',
            'proposed_family', 'Esmaltes tradicionales y gel',
            'review_status', 'Clasificado',
            'original_code', 'MAS022',
            'brand_or_line', 'MASGLO',
            'original_description', 'AUSENTE',
            'original_category', null,
            'supplier_code', null,
            'supplier', 'MAY'
          )
        )
      )
  where id = reconciliation_id;

  perform public.sync_catalog_review_work_items_v1();
end;
$migration$;

commit;
