-- 0145 · La autoridad es por dato, no por fuente. Y el precio necesita mercado.
--
-- Hasta aquí las 23 reglas de autoridad estaban todas por CLASE de fuente:
-- «kind:official → preferred en identity.*». Eso da exactamente la misma
-- autoridad a la tienda española de Masglo que a la peruana de Cherimoya sobre
-- absolutamente todo, que es el problema que se quería evitar un nivel más
-- abajo. Aquí se declara por fuente y por tipo de dato.
--
-- El criterio no es «cuál es la mejor fuente» sino «para QUÉ manda cada una»:
--
--   Una tienda oficial de marca manda sobre lo que ella fabrica y nombra:
--   presentación, tipo de producto, línea, composición, foto. Fue mirando la
--   ficha oficial de Admiss como se descubrió que ADM001 «Ajo y Limón» es una
--   BASE y no un esmalte — un error que llevaba meses en el catálogo.
--
--   Ninguna manda sobre el precio de otro mercado. Y ninguna manda sobre
--   nuestra identidad interna.
--
-- ── El hallazgo que obliga a lo del mercado ──────────────────────────────────
--
-- Los 3.406 precios externos capturados están TODOS guardados como PEN. Se lo
-- preguntamos a cada tienda y sus monedas reales son otras:
--
--   cherimoya.pe      PEN   ← la única correcta
--   mcnails.mx        MXN
--   acrylove.com      MXN   ← mexicana, pese al .com
--   bigen-usa.com     USD
--   masglo.com.es     EUR
--   admiss.com.co     COP
--
-- Así, los 3.900–15.900 de Admiss son pesos colombianos leídos como soles. Un
-- producto de 15.900 COP (~S/ 15) aparece como S/ 15.900. El importe estaba
-- bien; la etiqueta, no. Se corrige la etiqueta y queda anotado que se corrigió.

begin;

-- ── 1 · Cada fuente declara su mercado y su moneda ───────────────────────────
update public.catalog_sources set metadata = metadata || jsonb_build_object(
  'market', m.market, 'currency', m.currency, 'market_evidence', m.evidencia
) from (values
  ('cherimoya-pe-official',  'PE', 'PEN', 'la tienda declara currency_code PEN'),
  ('mc-nails-mx-official',   'MX', 'MXN', 'la tienda declara currency MXN'),
  ('acrylove-official',      'MX', 'MXN', 'la tienda declara currency MXN pese al dominio .com'),
  ('bigen-usa-official',     'US', 'USD', 'la tienda declara currency USD'),
  ('masglo-es-official',     'ES', 'EUR', 'la tienda declara currency EUR; es el canal español de una marca colombiana'),
  ('admiss-co-official',     'CO', 'COP', 'la tienda declara currency COP'),
  ('revel-pe-sumerlabs',     'PE', 'PEN', 'catálogo mayorista peruano; los importes son POR DOCENA'),
  ('bellespa-pe-sumerlabs',  'PE', 'PEN', 'catálogo mayorista peruano; los importes son POR DOCENA')
) as m(source_key, market, currency, evidencia)
where catalog_sources.source_key = m.source_key;

-- ── 2 · Corregir la etiqueta de moneda de los precios ya capturados ──────────
-- El importe nunca estuvo mal. Lo que estaba mal era llamarlo soles.
update public.catalog_reference_prices p
set currency = (s.metadata->>'currency'),
    metadata = p.metadata || jsonb_build_object(
      'currency_corrected_from', p.currency,
      'currency_corrected_by', '0145',
      'currency_source', 'declarada por la propia tienda'
    )
from public.catalog_sources s
where p.source_id = s.id
  and s.metadata ? 'currency'
  and p.currency is distinct from (s.metadata->>'currency');

-- ── 3 · Autoridad por fuente y por tipo de dato ──────────────────────────────
-- Se retiran primero las reglas propias de estas fuentes para que la migración
-- sea reejecutable sin acumular duplicados.
delete from public.catalog_source_predicate_authority
where source_id in (select id from public.catalog_sources where source_key in (
  'cherimoya-pe-official','mc-nails-mx-official','acrylove-official',
  'bigen-usa-official','masglo-es-official','admiss-co-official',
  'revel-pe-sumerlabs','bellespa-pe-sumerlabs'
));

insert into public.catalog_source_predicate_authority(
  source_id, source_role, predicate_pattern, source_field_pattern,
  dimension_code, authority_level, authority_score, rationale, conditions
)
select s.id, r.rol, r.predicado, '*', r.dimension, r.nivel, r.score, r.razon, r.condiciones::jsonb
from (values

  -- ── Lo que TODA tienda oficial de marca manda ──────────────────────────────
  -- Nombre, presentación, tipo y línea: es la marca describiendo su propio
  -- producto. Aquí no hay mejor fuente posible.
  ('*brand*','MERCHANDISING','official.title','type','preferred',1.0,
   'La marca nombra su propio producto. Es el nombre de fábrica, no el del revendedor.','{}'),
  ('*brand*','MERCHANDISING','official.presentation','packaging','preferred',1.0,
   'La presentación (13,5 ML, 1/2 OZ) es un hecho físico que declara quien lo envasa.','{}'),
  ('*brand*','TECHNICAL','official.product_type','type','preferred',1.0,
   'Mirando la ficha oficial se descubrió que ADM001 «Ajo y Limón» es una BASE y no un esmalte. Esta es la autoridad que corrige clasificaciones.','{}'),
  ('*brand*','TECHNICAL','official.line','type','preferred',1.0,
   'Solo la marca sabe a qué línea pertenece un tono. Masglo vende el mismo tono en Tradicional, Evolution y Polish Gel, y son tres productos.','{}'),
  ('*brand*','TECHNICAL','official.finish','finish','preferred',1.0,
   'El acabado lo define la formulación, que es de la marca.','{}'),
  ('*brand*','TECHNICAL','semantic.*','composition','preferred',1.0,
   'Composición y uso declarados por quien formula el producto.','{}'),

  -- Imagen: manda como REFERENCIA de qué aspecto tiene el producto. No como
  -- material publicable nuestro, que es una decisión distinta y con licencia.
  ('*brand*','MEDIA','official.primary_image','media','preferred',1.0,
   'Fotografía oficial del producto. Vale como referencia de identidad visual; NO autoriza a publicarla como imagen de Bellaroshé.',
   '{"uso":"remote_reference","no_autoriza":"publicacion_bellaroshe"}'),

  -- Identidad: manda sobre SU código, jamás sobre el nuestro.
  ('*brand*','IDENTITY','official.sku','identity','preferred',1.0,
   'El SKU de fábrica es de la marca y ella manda sobre él. Autoridad limitada a su propio espacio de nombres.',
   '{"ambito":"namespace_propio","nunca":"sku_interno_bellaroshe"}'),

  -- Stock: nunca. Que una tienda de México tenga o no existencias no dice
  -- absolutamente nada de las nuestras.
  ('*brand*','COMMERCIAL','availability.*','price','prohibited',0.0,
   'La disponibilidad de una tienda ajena no informa de la nuestra en ningún sentido.','{}')

) as r(marca, rol, predicado, dimension, nivel, score, razon, condiciones)
cross join public.catalog_sources s
where r.marca = '*brand*' and s.source_key in (
  'cherimoya-pe-official','mc-nails-mx-official','acrylove-official',
  'bigen-usa-official','masglo-es-official','admiss-co-official'
);

-- ── 4 · Precio externo: la autoridad depende del MERCADO, no de la marca ─────
-- Un precio solo es comparable dentro de su mercado. El de Cherimoya es
-- minorista peruano en soles y sirve para situarse; el de Masglo es minorista
-- español en euros y no significa nada aquí, por muy oficial que sea la fuente.
--
-- En ningún caso toca el precio de venta ni el costo interno de Bellaroshé: son
-- observaciones de mercado, y esa frontera es del negocio, no de los datos.
insert into public.catalog_source_predicate_authority(
  source_id, source_role, predicate_pattern, source_field_pattern,
  dimension_code, authority_level, authority_score, rationale, conditions
)
select s.id, 'COMMERCIAL', 'price.*', '*', 'price', r.nivel, r.score, r.razon, r.condiciones::jsonb
from (values
  ('cherimoya-pe-official','supplemental',0.45,
   'Minorista peruano en soles: mismo mercado, así que sirve para situar un rango. Sigue sin poder tocar costo ni precio de venta.',
   '{"mercado":"PE","moneda":"PEN","uso":"referencia_de_rango"}'),
  ('masglo-es-official','prohibited',0.0,
   'Minorista español en euros. Otro mercado, otra moneda, otra estructura de costes: no es comparable con un precio peruano.',
   '{"mercado":"ES","moneda":"EUR"}'),
  ('admiss-co-official','prohibited',0.0,
   'Minorista colombiano en pesos. Los 3.900–15.900 se estaban leyendo como soles.',
   '{"mercado":"CO","moneda":"COP"}'),
  ('mc-nails-mx-official','prohibited',0.0,
   'Minorista mexicano en pesos mexicanos. No comparable.','{"mercado":"MX","moneda":"MXN"}'),
  ('acrylove-official','prohibited',0.0,
   'Minorista mexicano en pesos mexicanos, pese al dominio .com.','{"mercado":"MX","moneda":"MXN"}'),
  ('bigen-usa-official','prohibited',0.0,
   'Minorista estadounidense en dólares. No comparable.','{"mercado":"US","moneda":"USD"}')
) as r(source_key, nivel, score, razon, condiciones)
join public.catalog_sources s on s.source_key = r.source_key;

-- ── 5 · Los dos distribuidores peruanos ──────────────────────────────────────
-- Caso distinto: no fabrican, pero SÍ son el canal por el que el producto llega
-- aquí, así que su código es el que de verdad se comercia. Y su precio es
-- mayorista POR DOCENA, que como precio unitario es sencillamente falso.
insert into public.catalog_source_predicate_authority(
  source_id, source_role, predicate_pattern, source_field_pattern,
  dimension_code, authority_level, authority_score, rationale, conditions
)
select s.id, r.rol, r.predicado, '*', r.dimension, r.nivel, r.score, r.razon, r.condiciones::jsonb
from (values
  ('IDENTITY','official.sku','identity','preferred',1.0,
   'El código del distribuidor es el que aparece en la factura y en el pedido: es el que de verdad se comercia en Perú.','{}'),
  ('MERCHANDISING','official.title','type','acceptable',0.7,
   'Nombran para vender, no para describir. Útil, pero por debajo del nombre de fábrica.','{}'),
  ('TECHNICAL','semantic.*','composition','supplemental',0.3,
   'Distribuyen, no formulan. Su descripción es de catálogo, no de ficha técnica.','{}'),
  ('COMMERCIAL','price.*','price','prohibited',0.0,
   'Los importes son POR DOCENA (S/144 el alicate, S/120 el neceser). Tomarlos como precio unitario multiplica por doce el error.',
   '{"unidad":"docena","nunca":"precio_unitario"}')
) as r(rol, predicado, dimension, nivel, score, razon, condiciones)
cross join public.catalog_sources s
where s.source_key in ('revel-pe-sumerlabs','bellespa-pe-sumerlabs');

-- ── 6 · La matriz, legible de un vistazo ─────────────────────────────────────
create or replace view public.source_authority_matrix_v1
with (security_invoker = true) as
select
  s.source_key,
  s.metadata->>'market'   as market,
  s.metadata->>'currency' as currency,
  a.source_role,
  a.predicate_pattern,
  a.dimension_code,
  a.authority_level,
  a.authority_score,
  a.conditions,
  a.rationale
from public.catalog_source_predicate_authority a
join public.catalog_sources s on s.id = a.source_id
where a.is_active
order by s.source_key, a.source_role, a.predicate_pattern;

comment on view public.source_authority_matrix_v1 is
  'Autoridad declarada por fuente y por tipo de dato. Ninguna fuente tiene '
  'autoridad global: manda sobre lo que le consta y calla sobre lo demás.';

grant select on public.source_authority_matrix_v1 to authenticated, service_role;

commit;
