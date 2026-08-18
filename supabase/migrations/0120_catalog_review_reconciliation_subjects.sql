-- 0120 · La Mesa presenta el destino interno, no el registro técnico de la fuente.
--
-- Las investigaciones official_identity_v1 nacen desde un source_record, pero
-- la decisión humana se toma sobre el producto, variante o tono interno al que
-- ese registro podría corresponder. Este trigger corrige el contrato actual y
-- cualquier corrida oficial futura, además de incorporar título, línea, imagen
-- y URL de referencia en el contexto que consume la interfaz.

begin;

create or replace function public.normalize_catalog_reconciliation_work_item_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  identity record;
  current_evidence jsonb;
begin
  if new.source_type <> 'reconciliation_case' or new.source_id is null then
    return new;
  end if;

  select
    reconciliation.entity_type,
    reconciliation.product_id,
    reconciliation.variant_id,
    reconciliation.shade_id,
    reconciliation.score,
    reconciliation.evidence,
    coalesce(reference_variant.name, reference_product.name) as official_title,
    coalesce(reference_parent.line, reference_product.line) as official_line,
    coalesce(reference_variant.presentation, reference_product.presentation) as official_presentation,
    coalesce(reference_variant.source_url, reference_product.source_url) as official_url,
    coalesce(reference_variant.primary_image_url, reference_product.primary_image_url) as official_image_url,
    coalesce(reference_variant.sku, reference_product.primary_external_id) as official_code,
    case reconciliation.entity_type
      when 'product' then internal_product.name
      when 'variant' then internal_variant.name
      when 'shade' then internal_shade.name
      else null
    end as internal_name
  into identity
  from public.catalog_reconciliation_cases reconciliation
  left join public.catalog_reference_products reference_product
    on reference_product.id = reconciliation.reference_product_id
  left join public.catalog_reference_variants reference_variant
    on reference_variant.id = reconciliation.reference_variant_id
  left join public.catalog_reference_products reference_parent
    on reference_parent.id = reference_variant.reference_product_id
  left join public.products internal_product
    on internal_product.id = reconciliation.product_id
  left join public.product_variants internal_variant
    on internal_variant.id = reconciliation.variant_id
  left join public.color_shades internal_shade
    on internal_shade.id = reconciliation.shade_id
  where reconciliation.id = new.source_id;

  if not found then
    return new;
  end if;

  new.subject_type := identity.entity_type;
  new.subject_id := case identity.entity_type
    when 'product' then identity.product_id
    when 'variant' then identity.variant_id
    when 'shade' then identity.shade_id
    else new.subject_id
  end;

  current_evidence := coalesce(new.context -> 'evidence', '{}'::jsonb)
    || coalesce(identity.evidence, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'official_title', identity.official_title,
      'official_line', identity.official_line,
      'official_presentation', identity.official_presentation,
      'official_url', identity.official_url,
      'official_image_url', identity.official_image_url,
      'official_code', identity.official_code,
      'internal_name', identity.internal_name
    ));

  new.context := coalesce(new.context, '{}'::jsonb)
    || jsonb_build_object(
      'score', identity.score,
      'evidence', current_evidence
    );

  return new;
end;
$function$;

drop trigger if exists catalog_review_work_items_normalize_reconciliation
  on public.catalog_review_work_items;
create trigger catalog_review_work_items_normalize_reconciliation
before insert or update of source_type, source_id, subject_type, subject_id, context
on public.catalog_review_work_items
for each row execute function public.normalize_catalog_reconciliation_work_item_v1();

-- Recorre únicamente las filas afectadas por el contrato antiguo. El trigger
-- determina el sujeto correcto y conserva toda la evidencia previa.
update public.catalog_review_work_items
set context = context
where source_type = 'reconciliation_case'
  and subject_type = 'source_record'
  and status in ('open', 'in_progress');

revoke all on function public.normalize_catalog_reconciliation_work_item_v1()
from public, anon, authenticated;

commit;
