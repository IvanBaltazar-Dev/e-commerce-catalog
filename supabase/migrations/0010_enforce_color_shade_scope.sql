begin;

create or replace function public.validate_color_shade_line_brand()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  line_brand_id uuid;
begin
  if new.product_line_id is null then
    return new;
  end if;

  select brand_id into line_brand_id
  from public.product_lines
  where id = new.product_line_id;

  if line_brand_id is distinct from new.brand_id then
    raise exception 'La línea del tono no pertenece a su marca.';
  end if;

  return new;
end;
$$;

create trigger color_shades_validate_line_brand
before insert or update of brand_id, product_line_id on public.color_shades
for each row execute function public.validate_color_shade_line_brand();

create or replace function public.validate_variant_color_shade_scope()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  product_brand_id uuid;
  product_line_id uuid;
  shade_brand_id uuid;
  shade_line_id uuid;
begin
  if new.color_shade_id is null then
    return new;
  end if;

  select brand_id, products.product_line_id
  into product_brand_id, product_line_id
  from public.products
  where id = new.product_id;

  select brand_id, color_shades.product_line_id
  into shade_brand_id, shade_line_id
  from public.color_shades
  where id = new.color_shade_id and is_active = true;

  if shade_brand_id is null or shade_brand_id is distinct from product_brand_id then
    raise exception 'El tono no pertenece a la marca del producto.';
  end if;

  if shade_line_id is not null and shade_line_id is distinct from product_line_id then
    raise exception 'El tono no pertenece a la línea comercial del producto.';
  end if;

  return new;
end;
$$;

create trigger product_variants_validate_color_shade_scope
before insert or update of product_id, color_shade_id on public.product_variants
for each row execute function public.validate_variant_color_shade_scope();

commit;
