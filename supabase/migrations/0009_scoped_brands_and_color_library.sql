begin;

-- Una marca es canónica y puede operar en varias familias sin duplicarse.
alter table public.brands
  add column is_generic boolean not null default false;

create unique index brands_single_generic_idx
on public.brands (is_generic)
where is_generic = true;

create table public.brand_product_families (
  brand_id uuid not null references public.brands(id) on delete cascade,
  template_id uuid not null references public.attribute_templates(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (brand_id, template_id)
);

create table public.product_line_product_families (
  product_line_id uuid not null references public.product_lines(id) on delete cascade,
  template_id uuid not null references public.attribute_templates(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (product_line_id, template_id)
);

create index brand_product_families_template_idx
on public.brand_product_families(template_id, brand_id);

create index product_line_families_template_idx
on public.product_line_product_families(template_id, product_line_id);

alter table public.brand_product_families enable row level security;
alter table public.product_line_product_families enable row level security;

create policy "authenticated read brand families"
on public.brand_product_families for select to authenticated
using (true);

create policy "admins manage brand families"
on public.brand_product_families for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "authenticated read product line families"
on public.product_line_product_families for select to authenticated
using (true);

create policy "admins manage product line families"
on public.product_line_product_families for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.brand_product_families to authenticated, service_role;
grant select, insert, update, delete on public.product_line_product_families to authenticated, service_role;

-- Una biblioteca de tonos evita convertir nombres comerciales en una lista global ambigua.
create table public.color_shades (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  product_line_id uuid references public.product_lines(id) on delete cascade,
  name text not null,
  code text not null,
  tone_option_id uuid unique references public.attribute_options(id) on delete set null,
  color_family_option_id uuid not null references public.attribute_options(id),
  reference_color text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint color_shades_name_not_blank check (length(trim(name)) > 0),
  constraint color_shades_code_not_blank check (length(trim(code)) > 0),
  constraint color_shades_reference_color_format check (reference_color is null or reference_color ~ '^#[0-9A-Fa-f]{6}$')
);

create unique index color_shades_scope_code_unique_idx
on public.color_shades(brand_id, coalesce(product_line_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(code));

create index color_shades_search_idx
on public.color_shades(brand_id, product_line_id, lower(name), lower(code));

alter table public.product_variants
  add column color_shade_id uuid references public.color_shades(id) on delete set null;

create index product_variants_color_shade_idx
on public.product_variants(color_shade_id)
where color_shade_id is not null;

create trigger color_shades_set_updated_at
before update on public.color_shades
for each row execute function public.set_updated_at();

alter table public.color_shades enable row level security;

create policy "public read active color shades"
on public.color_shades for select to anon, authenticated
using (is_active = true);

create policy "admins manage color shades"
on public.color_shades for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select on public.color_shades to anon;
grant select, insert, update, delete on public.color_shades to authenticated, service_role;

create or replace function public.validate_product_line_brand()
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
    raise exception 'La línea comercial no pertenece a la marca seleccionada.';
  end if;

  return new;
end;
$$;

create trigger products_validate_product_line_brand
before insert or update of brand_id, product_line_id on public.products
for each row execute function public.validate_product_line_brand();

create or replace function public.sync_product_family_assignments()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.template_id is null then
    return new;
  end if;

  insert into public.brand_product_families(brand_id, template_id)
  values (new.brand_id, new.template_id)
  on conflict do nothing;

  if new.product_line_id is not null then
    insert into public.product_line_product_families(product_line_id, template_id)
    values (new.product_line_id, new.template_id)
    on conflict do nothing;
  end if;

  return new;
end;
$$;

create trigger products_sync_family_assignments
after insert or update of brand_id, template_id, product_line_id on public.products
for each row execute function public.sync_product_family_assignments();

create or replace function public.create_color_shade(
  p_brand_id uuid,
  p_product_line_id uuid,
  p_name text,
  p_code text,
  p_color_family_option_id uuid,
  p_reference_color text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  shade_id uuid := gen_random_uuid();
  tone_definition_id uuid;
  family_definition_id uuid;
  selected_family_definition_id uuid;
  line_brand_id uuid;
  created_tone_option_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Se requieren permisos de administrador.' using errcode = '42501';
  end if;

  if length(trim(p_name)) = 0 or length(trim(p_code)) = 0 then
    raise exception 'El tono necesita nombre y código.';
  end if;

  if p_product_line_id is not null then
    select brand_id into line_brand_id from public.product_lines where id = p_product_line_id;
    if line_brand_id is distinct from p_brand_id then
      raise exception 'La línea comercial no pertenece a la marca seleccionada.';
    end if;
  end if;

  select id into tone_definition_id from public.attribute_definitions where code = 'tone' and is_active = true;
  select id into family_definition_id from public.attribute_definitions where code = 'color_family' and is_active = true;
  select attribute_definition_id into selected_family_definition_id
  from public.attribute_options
  where id = p_color_family_option_id and is_active = true;

  if tone_definition_id is null or family_definition_id is null or selected_family_definition_id is distinct from family_definition_id then
    raise exception 'La configuración de tonos o familia cromática no es válida.';
  end if;

  insert into public.color_shades(
    id, brand_id, product_line_id, name, code, color_family_option_id, reference_color
  ) values (
    shade_id, p_brand_id, p_product_line_id, trim(p_name), trim(p_code),
    p_color_family_option_id, nullif(trim(p_reference_color), '')
  );

  insert into public.attribute_options(attribute_definition_id, value, label, metadata)
  values (
    tone_definition_id,
    'shade-' || replace(shade_id::text, '-', ''),
    trim(p_name),
    jsonb_build_object('shadeId', shade_id, 'code', trim(p_code))
  )
  returning id into created_tone_option_id;

  update public.color_shades
  set tone_option_id = created_tone_option_id
  where id = shade_id;

  return shade_id;
end;
$$;

grant execute on function public.create_color_shade(uuid, uuid, text, text, uuid, text) to authenticated, service_role;

-- Todo producto existente enseña qué familias trabaja realmente su marca y su línea.
insert into public.brand_product_families(brand_id, template_id)
select distinct brand_id, template_id
from public.products
where template_id is not null
on conflict do nothing;

insert into public.product_line_product_families(product_line_id, template_id)
select distinct product_line_id, template_id
from public.products
where product_line_id is not null and template_id is not null
on conflict do nothing;

-- Conocimiento inicial confirmado por el catálogo actual. Una marca puede recibir más familias después.
insert into public.brand_product_families(brand_id, template_id)
select brand.id, template.id
from (
  values
    ('masglo', 'ESMALTE_TONOS'),
    ('cherimoya', 'ESMALTE_TONOS'),
    ('flower-secret', 'ESMALTE_TONOS'),
    ('glam-nails', 'ESMALTE_TONOS'),
    ('mystyle', 'ESMALTE_TONOS'),
    ('candy-secret', 'ESMALTE_TONOS'),
    ('admiss', 'ESMALTE_TONOS')
) as assignment(brand_slug, template_code)
join public.brands brand on brand.slug = assignment.brand_slug
join public.attribute_templates template on template.code = assignment.template_code
on conflict do nothing;

insert into public.brands(name, slug, description, is_generic, sort_order)
values ('Genérica / sin marca', 'generica-sin-marca', 'Productos sin una marca comercial identificada.', true, 9999)
on conflict (slug) do update
set name = excluded.name, description = excluded.description, is_generic = true, is_active = true;

insert into public.brand_product_families(brand_id, template_id)
select brand.id, template.id
from public.brands brand
cross join public.attribute_templates template
where brand.slug = 'generica-sin-marca'
  and template.code in ('ESMALTE_TONOS', 'PESTANA_TIRA', 'EXTENSIONES_PRO', 'ADHESIVO_PRO', 'LAMPARA', 'TORNO_ELECTRICO', 'MAQUINA_CORTE', 'ACCESORIO_REPUESTO')
on conflict do nothing;

insert into public.product_lines(brand_id, name, slug, description, sort_order)
select id, 'Gel Evolution', 'gel-evolution', 'Línea de esmaltes Masglo.', 10
from public.brands where slug = 'masglo'
on conflict (brand_id, slug) do update set name = excluded.name, is_active = true;

insert into public.product_line_product_families(product_line_id, template_id)
select line.id, template.id
from public.product_lines line
join public.brands brand on brand.id = line.brand_id and brand.slug = 'masglo'
join public.attribute_templates template on template.code = 'ESMALTE_TONOS'
where line.slug = 'gel-evolution'
on conflict do nothing;

update public.products product
set product_line_id = line.id
from public.product_lines line
join public.brands brand on brand.id = line.brand_id and brand.slug = 'masglo'
where product.slug = 'demo-masglo-gel-evolution'
  and line.slug = 'gel-evolution'
  and product.brand_id = brand.id;

-- Recupera los tonos del seed V2 cuando ya existen en la base local actual.
insert into public.color_shades(
  brand_id, product_line_id, name, code, tone_option_id, color_family_option_id
)
select distinct
  product.brand_id,
  product.product_line_id,
  variant.name,
  variant.sku,
  tone_value.option_id,
  family_value.option_id
from public.product_variants variant
join public.products product on product.id = variant.product_id
join public.attribute_templates template on template.id = product.template_id and template.code = 'ESMALTE_TONOS'
join public.variant_attribute_values tone_value on tone_value.variant_id = variant.id
join public.attribute_definitions tone_definition on tone_definition.id = tone_value.attribute_definition_id and tone_definition.code = 'tone'
join public.variant_attribute_values family_value on family_value.variant_id = variant.id
join public.attribute_definitions family_definition on family_definition.id = family_value.attribute_definition_id and family_definition.code = 'color_family'
where tone_value.option_id is not null and family_value.option_id is not null
on conflict do nothing;

update public.product_variants variant
set color_shade_id = shade.id
from public.products product, public.color_shades shade
where product.id = variant.product_id
  and shade.brand_id = product.brand_id
  and shade.product_line_id is not distinct from product.product_line_id
  and exists (
    select 1
    from public.variant_attribute_values value
    join public.attribute_definitions definition on definition.id = value.attribute_definition_id and definition.code = 'tone'
    where value.variant_id = variant.id and value.option_id = shade.tone_option_id
  );

commit;
