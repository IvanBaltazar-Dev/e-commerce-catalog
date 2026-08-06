begin;

delete from public.brand_product_families assignment
using public.brands brand, public.attribute_templates template
where assignment.brand_id = brand.id
  and assignment.template_id = template.id
  and brand.slug = 'admiss'
  and template.code = 'TORNO_ELECTRICO';

insert into public.brand_product_families(brand_id, template_id)
select brand.id, template.id
from public.brands brand
cross join public.attribute_templates template
where brand.slug = 'admiss'
  and template.code = 'ESMALTE_TONOS'
on conflict do nothing;

commit;
