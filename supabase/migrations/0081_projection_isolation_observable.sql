-- ---------------------------------------------------------------------------
-- 0081 · El aislamiento tiene que poder comprobarse, no solo afirmarse
-- ---------------------------------------------------------------------------
-- `product_catalog_projection` guarda dos cosas con responsabilidades
-- distintas —el documento de búsqueda y el precio inicial— y las dos escribían
-- el mismo `updated_at`. Con una sola marca de tiempo no se puede distinguir
-- «se reescribió el documento» de «se recalculó el precio», y por tanto no se
-- puede escribir la prueba que garantiza que renombrar una marca NO recalcula
-- precios: al medirlo, 543 filas parecían precios recalculados y eran
-- documentos reescritos.
--
-- Una garantía que no se puede medir es una intención. Dos columnas.
-- ---------------------------------------------------------------------------

begin;

alter table public.product_catalog_projection
  add column if not exists search_updated_at timestamptz not null default now(),
  add column if not exists price_updated_at timestamptz not null default now();

comment on column public.product_catalog_projection.search_updated_at is
  'Cuándo se reescribió el documento. Separada de price_updated_at para que la prueba de aislamiento pueda afirmar que renombrar una marca no recalculó ningún precio.';

comment on column public.product_catalog_projection.price_updated_at is
  'Cuándo se recalculó el precio inicial. Separada de search_updated_at por la misma razón, en el otro sentido: cambiar un precio no puede reescribir documentos.';

create or replace function public.refresh_product_catalog_search(p_product_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  if p_product_ids is null or array_length(p_product_ids, 1) is null then return 0; end if;

  insert into public.product_catalog_projection (product_id, search_document, search_updated_at)
  select agregado.product_id, agregado.documento, now()
  from (
    select partes.product_id,
           btrim(coalesce(max(partes.texto_producto), '') || ' ' ||
                 coalesce(string_agg(distinct partes.texto_variante, ' '), '')) as documento
    from public.variant_search_parts partes
    join public.product_variants variante
      on variante.id = partes.variant_id and variante.is_active
    join unnest(p_product_ids) as pedido(id) on pedido.id = partes.product_id
    group by partes.product_id
  ) agregado
  on conflict (product_id) do update
  set search_document = excluded.search_document,
      search_updated_at = now(),
      updated_at = now()
  where public.product_catalog_projection.search_document is distinct from excluded.search_document;

  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

create or replace function public.refresh_product_catalog_price(p_product_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  if p_product_ids is null or array_length(p_product_ids, 1) is null then return 0; end if;

  insert into public.product_catalog_projection (product_id, search_document, starting_price, price_updated_at)
  select pedido.id, '', calculado.precio, now()
  from unnest(p_product_ids) as pedido(id)
  cross join lateral (
    select min(price.amount) as precio
    from public.product_variants variante
    join public.variant_prices price on price.variant_id = variante.id
    join public.price_lists lista on lista.id = price.price_list_id
    where variante.product_id = pedido.id
      and variante.is_active and price.is_active and price.validity @> now()
      and lista.is_active and lista.is_public and lista.price_type = 'retail'
  ) calculado
  on conflict (product_id) do update
  set starting_price = excluded.starting_price,
      price_updated_at = now(),
      updated_at = now()
  where public.product_catalog_projection.starting_price is distinct from excluded.starting_price;

  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

commit;
