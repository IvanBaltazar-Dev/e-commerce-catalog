-- Las fichas técnicas y catálogos se referencian como medios del producto,
-- pero nunca se embeben dentro del XLSX. El cargador exige que ya existan.
update storage.buckets
set allowed_mime_types = array[
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf'
]
where id = 'catalog-assets';
