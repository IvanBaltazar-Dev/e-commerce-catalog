-- 0134 · Masglo tiene líneas, y un tono no es un producto.
--
-- El catálogo tenía UN producto «Esmalte MASGLO» con 164 tonos y un solo
-- precio. Masglo no vende eso: vende líneas distintas, y el mismo nombre de
-- tono existe en varias a la vez, con envase, precio y foto propios.
--
--   CAMPEONA  →  Tradicional     esmalte cremoso 13,5 ml      10,69
--             →  Gel Evolution   esmalte efecto gel 13,5 ml    8,50
--             →  Gel Polish      semipermanente 7 ml          10,28
--
-- Por eso la carga masiva de imágenes no podía acertar: emparejaba por nombre
-- de tono, y el nombre de tono no identifica un producto. Ninguna cantidad de
-- grafo arregla un identificador que no identifica.
--
-- Lo que sí identifica es el SKU. Cruzando los 164 contra el SKU oficial de
-- masglo.com.es (research/catalog-master/data, CONFIRMADO_OFICIAL):
--
--    48  Tradicional · ESMALTE      ← lo que de verdad tenemos
--     5  ESMALTE DECORACIÓN         ← no son tonos de la carta
--     3  BRILLO                     ← tampoco
--   108  sin SKU en el sitio de España (surtido peruano distinto)
--     0  Gel Evolution
--     0  Gel Polish
--
-- Es decir: «Esmalte MASGLO» ES la línea Tradicional, con ocho intrusos
-- dentro. Gel Evolution y Gel Polish no están en la base — hay carta de
-- colores de ambas en el material de origen, pero ningún producto cargado.
-- Esta migración no los inventa: nombra las líneas y deja el hueco visible.

begin;

-- ── 1. Las líneas, como dato y no como palabra en un nombre ─────────────────

insert into public.product_lines (brand_id, name, slug, description, sort_order)
select b.id, v.name, v.slug, v.description, v.sort_order
from public.brands b
cross join (values
  ('Tradicional',   'tradicional',   'Esmalte cremoso 13,5 ml. No requiere lámpara.',              10),
  ('Gel Evolution', 'gel-evolution', 'Esmalte efecto gel 13,5 ml. No requiere lámpara.',           20),
  ('Gel Polish',    'gel-polish',    'Esmalte semipermanente 7 y 14 ml. Requiere lámpara UV/LED.', 30),
  ('Advanced',      'advanced',      'Bases y tratamientos recuperadores de uña.',                 40)
) as v(name, slug, description, sort_order)
where b.name = 'Masglo'
on conflict (brand_id, slug) do update
  set name = excluded.name,
      description = excluded.description,
      sort_order = excluded.sort_order;

insert into public.product_lines (brand_id, name, slug, description, sort_order)
select b.id, v.name, v.slug, v.description, v.sort_order
from public.brands b
cross join (values
  ('Esmalte tradicional', 'esmalte-tradicional', 'Esmalte tradicional 10 ml.',              10),
  ('Bases',               'bases',               'Bases tradicionales fortalecedoras 10 ml.', 20),
  ('Brillos',             'brillos',             'Brillos y finalizadores 10 ml.',           30)
) as v(name, slug, description, sort_order)
where b.name = 'Admiss'
on conflict (brand_id, slug) do update
  set name = excluded.name,
      description = excluded.description,
      sort_order = excluded.sort_order;

-- ── 2. Los dos esmaltes publicados dicen a qué línea pertenecen ─────────────
--
-- «Esmalte MASGLO» pasa a llamarse por su línea. Que dos productos futuros se
-- llamen «Esmalte Masglo» a secas y se distingan solo por un campo que la
-- pantalla no enseña es el mismo error de otra forma.

update public.products p
set product_line_id = l.id,
    name = 'Esmalte Masglo Tradicional',
    short_description = 'Esmalte tradicional cremoso 13,5 ml. No requiere lámpara.'
from public.product_lines l
join public.brands b on b.id = l.brand_id
where p.code = 'MAS-ESM-4C95F3' and b.name = 'Masglo' and l.slug = 'tradicional';

update public.products p
set product_line_id = l.id,
    name = 'Esmalte Admiss Tradicional',
    short_description = 'Esmalte tradicional 10 ml.'
from public.product_lines l
join public.brands b on b.id = l.brand_id
where p.code = 'ADM-ESM-CA6EEA' and b.name = 'Admiss' and l.slug = 'esmalte-tradicional';

-- ── 3. Los ocho intrusos de Masglo ──────────────────────────────────────────
--
-- Cada uno YA existe como producto propio en su categoría correcta. No hay que
-- crear nada: hay que dejar de tenerlo dos veces. Se apaga la copia que vive
-- como tono y su foto se pasa a la variante buena, que estaba sin imagen.
--
--   tono en Esmaltes          SKU oficial   producto correcto que ya existe
--   ───────────────────────   ───────────   ────────────────────────────────
--   Coral                     311032        MAS-BAS-485F70 · Brillo / Coral
--   Rosa                      311148        MAS-BAS-485F70 · Brillo / Rosa
--   Benevolente               312410        MAS-BAS-EA67FB · Brillo Benevolente
--   Tiza · Decoración         311757        MAS-DEC-6645CF · Tiza Decoracion
--   Negro · Decoración        311755        MAS-DEC-FBABA2 · Decoracion / Negro
--   Amarillo                  311746        (decoración estándar, sin producto propio)
--   Escarchado Dorado         311749        (duplicado interno de MAS105)
--   Escarchado Plata          311750        (duplicado interno de MAS106)

create temporary table intrusos_masglo (
  sku_tono text primary key,
  destino_sku text,
  motivo text
) on commit drop;

insert into intrusos_masglo (sku_tono, destino_sku, motivo) values
  ('311032', 'MAS085', 'BRILLO TRADICIONAL CON PARTICULAS MASGLO CORAL 13,5 ML'),
  ('311148', 'MAS084', 'BRILLO TRADICIONAL CON PARTICULAS MASGLO ROSA 13,5 ML'),
  ('312410', 'MAS091', 'BRILLO TRADICIONAL CON PARTICULAS MASGLO BENEVOLENTE 13,5 ML'),
  ('311757', 'MAS103', 'TIZA - ESMALTE DECORACIÓN ESTANDAR MASGLO 13,5 ML'),
  ('311755', 'MAS104', 'NEGRO - ESMALTE DECORACIÓN ESTANDAR MASGLO 13,5 ML'),
  ('311749', 'MAS105', 'ESCARCHADO DORADO - ESMALTE DECORACIÓN ESTANDAR MASGLO 13,5 ML'),
  ('311750', 'MAS106', 'ESCARCHADO PLATA - ESMALTE DECORACIÓN ESTANDAR MASGLO 13,5 ML'),
  ('311746', null,     'AMARILLO - ESMALTE DECORACIÓN ESTANDAR MASGLO 13,5 ML');

-- La foto viaja al destino ANTES de apagar el origen: si no, la única imagen
-- real de ese brillo se quedaría colgando de una variante inactiva.
--
-- Solo viaja si el destino no tiene ya imagen en ese rol. El índice único
-- (variant_id, media_role) donde is_primary lo impediría, y sobrescribir una
-- foto buena por otra no es el objetivo.
update public.product_media pm
set variant_id = destino.id
from intrusos_masglo i
join public.product_variants origen on origen.sku = i.sku_tono
join public.product_variants destino on destino.sku = i.destino_sku
where pm.variant_id = origen.id
  and i.destino_sku is not null
  and not exists (
    select 1 from public.product_media otro
    where otro.variant_id = destino.id and otro.media_role = pm.media_role
  );

-- Y ahora sí: la copia que vivía como tono deja de estar activa. No se borra,
-- porque una venta pasada puede apuntarla y porque el borrado esconde la
-- historia de por qué estaba ahí.
update public.product_variants v
set is_active = false
from intrusos_masglo i, public.products p
where v.sku = i.sku_tono
  and v.product_id = p.id
  and p.code = 'MAS-ESM-4C95F3';

-- ── 4. Las bases de Admiss ──────────────────────────────────────────────────
--
-- Aquí sí hay que crear: Admiss tiene diez productos en «Bases, tops y
-- finalizadores» y los diez son brillos. Base, ninguna. Mientras tanto, dos
-- bases estaban dentro del esmalte haciéndose pasar por tonos.
--
--   ADM001                 Ajo y Limon                → BASE TRADICIONAL FORTALECEDORA ADMISS AJO Y LIMON 10 ML
--                                                        admiss.com.co/products/base-para-unas-ajo-y-limon-10ml
--   ADM-ESM-CA6EEA-397E39  Vitamina Plus Tapa Plomo   → BASE FORTALECEDORA ADMISS VITAMIN PLUS 10 ML
--
-- La ficha oficial las clasifica en la colección «Bases», product_type BASES.
-- Son tratamiento de uña, no color: enseñarlas en la carta de tonos hace creer
-- a la clienta que se está llevando un esmalte.

insert into public.products (
  code, slug, brand_id, category_id, template_id, product_line_id,
  name, presentation, product_type, short_description,
  unit_price, wholesale_price, editorial_status, is_active, sort_order
)
select
  v.code, v.slug, b.id, c.id, plantilla.template_id, l.id,
  v.name, '10 ml', 'Base de tratamiento', v.short_description,
  0, 0, 'draft', true, 0
from public.brands b
cross join public.categories c
cross join public.product_lines l
cross join lateral (
  select p.template_id from public.products p where p.code = 'ADM-ESM-CA6EEA'
) plantilla
cross join (values
  ('ADM-BASE-AJOLIMON', 'base-admiss-ajo-y-limon', 'Base Fortalecedora Ajo y Limón',
   'Base tradicional fortalecedora Admiss 10 ml. Tratamiento, no color.'),
  ('ADM-BASE-VITAMINPLUS', 'base-admiss-vitamin-plus', 'Base Fortalecedora Vitamin Plus',
   'Base fortalecedora Admiss 10 ml. Tratamiento, no color.')
) as v(code, slug, name, short_description)
where b.name = 'Admiss'
  and c.slug = 'bases-y-tops'
  and l.brand_id = b.id and l.slug = 'bases'
on conflict (code) do nothing;

-- Las variantes se mudan enteras: con su SKU, su historia y su foto si la
-- tienen. Mudarlas conserva lo que ya se sabía de ellas; recrearlas lo perdería.
update public.product_variants v
set product_id = destino.id,
    name = destino.name,
    variant_key = 'base:' || destino.slug,
    is_default = true
from public.products destino, public.products origen
where origen.code = 'ADM-ESM-CA6EEA'
  and v.product_id = origen.id
  and (
    (v.sku = 'ADM001' and destino.code = 'ADM-BASE-AJOLIMON')
    or (v.sku = 'ADM-ESM-CA6EEA-397E39' and destino.code = 'ADM-BASE-VITAMINPLUS')
  );

-- ── 5. Sucesión de la variante predeterminada ───────────────────────────────
--
-- «Ajo y Limón» era la variante por defecto de Esmalte ADMISS: siendo ADM001,
-- encabezaba la lista por orden alfabético de SKU. Sacarla dejó al producto sin
-- predeterminada y la base lo rechazó —correctamente— con
-- assert_active_product_has_default_variant.
--
-- Que la base defendiera esa invariante es la razón por la que se puede mover
-- catálogo con confianza. Aquí se nombra sucesora: la primera variante activa
-- por orden de presentación, que es la que la pantalla enseñaría igualmente.
update public.product_variants v
set is_default = true
from (
  select distinct on (p.id) p.id as product_id, cand.id as variant_id
  from public.products p
  join public.product_variants cand on cand.product_id = p.id and cand.is_active
  where p.is_active
    and not exists (
      select 1 from public.product_variants d
      where d.product_id = p.id and d.is_active and d.is_default
    )
  order by p.id, cand.sort_order, cand.name
) sucesion
where v.id = sucesion.variant_id;

commit;
