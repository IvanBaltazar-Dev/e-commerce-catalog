begin;

-- Carta de colores en PDF (multipágina) además de la imagen del slot 03.
-- Cubre marcas cuyo muestrario es un documento completo (p. ej. Mystyle).
alter table public.products
  add column if not exists color_chart_pdf_path text;

-- El bucket público de assets ahora acepta PDF para servir esas cartas.
update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']
where id = 'catalog-assets';

commit;
