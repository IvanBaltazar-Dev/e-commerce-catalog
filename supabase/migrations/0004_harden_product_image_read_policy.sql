begin;

drop policy if exists "public read active product images"
on public.product_images;

create policy "public read active product images"
on public.product_images
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.products
    join public.brands
      on brands.id = products.brand_id
    join public.categories
      on categories.id = products.category_id
    where products.id = product_images.product_id
      and products.is_active = true
      and brands.is_active = true
      and categories.is_active = true
  )
);

commit;
