-- 0135 · Los siete que la fuente oficial no podía ver.
--
-- 0134 sacó ocho intrusos del esmalte de Masglo cruzando contra el SKU oficial.
-- Quedaban siete más del mismo tipo, invisibles a esa vara: llevan correlativo
-- interno (MAS083, MAS101…) y masglo.com.es no sabe nada de esos códigos.
--
-- Los encontró scripts/auditar-coherencia-interna.mjs, que no pregunta a nadie
-- de fuera: busca lo mismo existiendo dos veces en dos categorías distintas.
--
--   Brillo Confianza   producto en Bases  +  tono «Confianza» en Esmaltes
--   Brillo Ajedrez     producto en Bases  +  tono «Ajedrez»
--   Brillo Destellos   producto en Bases  +  tono «Destellos»
--   Brillo Tres Oros   producto en Bases  +  tono «Tres Oros»
--   Brillo Arcoiris    producto en Bases  +  tono «Arcoíris»
--   Brillo Seda        producto en Bases  +  tono «Seda»
--   Tiza Decoracion    producto en Deco   +  tono «Tiza»
--
-- Los siete son brillos o decoración vendidos como si fueran un color de la
-- carta. Una clienta que pide «Seda» viendo la carta de tonos espera un
-- esmalte y recibiría un brillo.
--
-- Esta es la razón de tener el detector: la corrección de 0134 no era el final
-- de la lista, era el primer octavo de ella. Sin una prueba que enumere, cada
-- arreglo destapa el siguiente y nunca se sabe cuántos faltan.

begin;

create temporary table duplicados_masglo (
  sku_tono text primary key,
  sku_destino text not null,
  producto_destino text not null
) on commit drop;

insert into duplicados_masglo (sku_tono, sku_destino, producto_destino) values
  ('311406', 'MAS087', 'MAS-BAS-AA8352'),  -- Confianza  → Brillo Confianza
  ('311156', 'MAS083', 'MAS-BAS-4A5948'),  -- Ajedrez    → Brillo Ajedrez
  ('312691', 'MAS088', 'MAS-BAS-A87DF1'),  -- Destellos  → Brillo Destellos
  ('312690', 'MAS090', 'MAS-BAS-298094'),  -- Tres Oros  → Brillo Tres Oros
  ('312693', 'MAS089', 'MAS-BAS-47031A'),  -- Arcoíris   → Brillo Arcoiris
  ('312692', 'MAS025', 'MAS-BAS-C07AEC'),  -- Seda       → Brillo Seda
  ('MAS101', 'MAS103', 'MAS-DEC-6645CF');  -- Tiza       → Tiza Decoracion

-- La foto viaja primero, igual que en 0134: si se apagara antes el origen, la
-- única imagen de ese brillo quedaría colgando de una variante inactiva. Solo
-- viaja si el destino no tiene ya imagen en ese rol.
update public.product_media pm
set variant_id = destino.id
from duplicados_masglo d
join public.product_variants origen on origen.sku = d.sku_tono
join public.product_variants destino on destino.sku = d.sku_destino
join public.products pd on pd.id = destino.product_id and pd.code = d.producto_destino
where pm.variant_id = origen.id
  and not exists (
    select 1 from public.product_media otro
    where otro.variant_id = destino.id and otro.media_role = pm.media_role
  );

update public.product_variants v
set is_active = false
from duplicados_masglo d, public.products p
where v.sku = d.sku_tono
  and v.product_id = p.id
  and p.code = 'MAS-ESM-4C95F3';

-- ── Los brillos y la decoración de Masglo también tienen línea ──────────────
--
-- 0134 nombró las líneas y se las puso a los dos esmaltes. Los 25 productos
-- restantes de Masglo y los 10 de Admiss se quedaron sin ninguna, que es como
-- volver a no tenerlas: un brillo Masglo es Tradicional igual que el esmalte.
update public.products p
set product_line_id = l.id
from public.product_lines l, public.brands b
where b.name = 'Masglo'
  and l.brand_id = b.id and l.slug = 'tradicional'
  and p.brand_id = b.id
  and p.product_line_id is null;

update public.products p
set product_line_id = l.id
from public.product_lines l, public.brands b, public.categories c
where b.name = 'Admiss'
  and l.brand_id = b.id
  and p.brand_id = b.id
  and p.category_id = c.id
  and p.product_line_id is null
  and l.slug = case
    when c.name = 'Bases, tops y finalizadores' then 'brillos'
    else 'esmalte-tradicional'
  end;

-- Los diez «Brillo …» de Admiss estaban en Bases, tops y finalizadores, que es
-- su sitio: la línea oficial que les corresponde es Brillos, no Bases. Las
-- bases de Admiss son las dos que 0134 creó, y ya llevan la suya.

commit;
