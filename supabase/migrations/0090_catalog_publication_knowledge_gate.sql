-- ---------------------------------------------------------------------------
-- 0090 · La edición recomienda; la publicación exige hechos revisados
-- ---------------------------------------------------------------------------
-- Un borrador puede conservar atributos pendientes. Al publicar, ningún valor
-- needs_review ni una procedencia aprobada desplazada puede quedar visible.

begin;

create or replace function public.assert_published_catalog_knowledge_ready()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  affected_product_id uuid;
begin
  if tg_table_name = 'products' then
    affected_product_id := coalesce(new.id, old.id);
  elsif tg_table_name = 'product_attribute_values' then
    affected_product_id := coalesce(new.product_id, old.product_id);
  else
    select variant.product_id into affected_product_id
    from public.product_variants variant
    where variant.id = coalesce(new.variant_id, old.variant_id);
  end if;

  if not exists (
    select 1 from public.products product
    where product.id = affected_product_id
      and product.is_active
      and product.editorial_status = 'published'
  ) then
    return null;
  end if;

  if exists (
    select 1
    from public.product_attribute_values value
    where value.product_id = affected_product_id and value.needs_review
  ) or exists (
    select 1
    from public.variant_attribute_values value
    join public.product_variants variant on variant.id = value.variant_id
    where variant.product_id = affected_product_id
      and variant.is_active
      and value.needs_review
  ) then
    raise exception using
      errcode = '23514',
      message = 'No se puede publicar mientras existan atributos pendientes de revisión.';
  end if;

  if exists (
    select 1
    from public.catalog_attribute_provenance provenance
    where provenance.decision_status = 'approved'
      and (
        provenance.product_id = affected_product_id
        or provenance.variant_id in (
          select variant.id from public.product_variants variant
          where variant.product_id = affected_product_id and variant.is_active
        )
      )
      and not exists (
        select 1 from public.product_attribute_values value
        where value.provenance_id = provenance.id
        union all
        select 1 from public.variant_attribute_values value
        where value.provenance_id = provenance.id
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'No se puede publicar: una procedencia aprobada fue desplazada y necesita resolución.';
  end if;

  return null;
end;
$function$;

create constraint trigger products_validate_knowledge_publication
after insert or update on public.products
deferrable initially deferred
for each row execute function public.assert_published_catalog_knowledge_ready();

create constraint trigger product_attributes_validate_knowledge_publication
after insert or update or delete on public.product_attribute_values
deferrable initially deferred
for each row execute function public.assert_published_catalog_knowledge_ready();

create constraint trigger variant_attributes_validate_knowledge_publication
after insert or update or delete on public.variant_attribute_values
deferrable initially deferred
for each row execute function public.assert_published_catalog_knowledge_ready();

revoke execute on function public.assert_published_catalog_knowledge_ready()
from public, anon, authenticated;

create or replace view public.catalog_knowledge_gate_v2
with (security_invoker = true) as
select * from public.catalog_knowledge_gate_v1
union all
select
  'published_attributes_needing_review'::text,
  'blocking'::text,
  count(*) = 0,
  count(*)::bigint,
  'Atributos pendientes de revisión que pertenecen a productos publicados.'::text
from (
  select value.id
  from public.product_attribute_values value
  join public.products product on product.id = value.product_id
  where product.is_active and product.editorial_status = 'published' and value.needs_review
  union all
  select value.id
  from public.variant_attribute_values value
  join public.product_variants variant on variant.id = value.variant_id and variant.is_active
  join public.products product on product.id = variant.product_id
  where product.is_active and product.editorial_status = 'published' and value.needs_review
) pending
union all
select
  'published_approved_provenance_displaced'::text,
  'blocking'::text,
  count(*) = 0,
  count(*)::bigint,
  'Procedencias aprobadas de productos publicados que ya no sostienen el valor operativo.'::text
from public.catalog_attribute_provenance provenance
where provenance.decision_status = 'approved'
  and (
    exists (
      select 1 from public.products product
      where product.id = provenance.product_id
        and product.is_active and product.editorial_status = 'published'
    )
    or exists (
      select 1
      from public.product_variants variant
      join public.products product on product.id = variant.product_id
      where variant.id = provenance.variant_id and variant.is_active
        and product.is_active and product.editorial_status = 'published'
    )
  )
  and not exists (
    select 1 from public.product_attribute_values value where value.provenance_id = provenance.id
    union all
    select 1 from public.variant_attribute_values value where value.provenance_id = provenance.id
  );

grant select on public.catalog_knowledge_gate_v2 to authenticated, service_role;

comment on view public.catalog_knowledge_gate_v2 is
  'Gate v1 más integridad de publicación: editar y guardar sigue permitido; publicar hechos pendientes no.';

commit;
