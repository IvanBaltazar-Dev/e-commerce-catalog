-- 0141 · El namespace es el SISTEMA de códigos, no quien nos lo vendió.
--
-- 0140 puso el proveedor como namespace de SUPPLIER_SKU. Era mejor que la marca
-- —los LC25xx de CHARM LIMIT quedaron bajo ROSE&LIN, que es el importador, y eso
-- sí es correcto— pero sigue siendo la respuesta a la pregunta equivocada.
--
-- La evidencia está en nuestros propios datos. Contando prefijos de código
-- contra proveedor y marca:
--
--     SS   49 códigos   2 proveedores (CHINO PUNO, MAY)      5 marcas
--     DY   23           2 proveedores (CHINO PUNO, MAY)      6 marcas
--     SH   13           2 proveedores (CHINO PUNO, REVEL)    2 marcas
--     LS    3           3 proveedores (FLORES SHI, RONGQIAN, WEDOR)
--
-- Y en importaciones a Perú del mismo periodo, `LS241-*` aparece bajo Candy
-- Secret, bajo ICONSIGN y bajo productos sin marca. Nuestro `LS241-080` es una
-- lima en disco sin marca comprada a WEDOR.
--
-- O sea: `SS` no es «el sistema de MAY» ni «el sistema de CHINO PUNO». Es un
-- sistema de códigos del exportador o del catálogo de origen, y los proveedores
-- locales revenden desde él. Poner al proveedor como namespace haría que
-- `SS-436` comprado a MAY y `SS-436` comprado a CHINO PUNO parecieran dos
-- códigos distintos.
--
-- Hoy no hay ni una colisión —ningún valor aparece bajo dos proveedores— así que
-- esto no corrige un error presente: cierra uno que el próximo lote traería.
--
-- El proveedor no se pierde. Pasa a ser lo que siempre fue: una OBSERVACIÓN de
-- quién nos lo vendió, no parte de la identidad del código.

begin;

alter table public.variant_identifiers
  drop constraint if exists variant_identifiers_namespace_allowed;
alter table public.variant_identifiers
  add constraint variant_identifiers_namespace_allowed
  check (namespace_kind in ('GLOBAL_GS1', 'BRAND', 'SUPPLIER', 'SOURCE', 'BELLAROSHE', 'CODE_SYSTEM'));

alter table public.catalog_reference_identifiers
  drop constraint if exists catalog_reference_identifiers_namespace_allowed;
alter table public.catalog_reference_identifiers
  add constraint catalog_reference_identifiers_namespace_allowed
  check (namespace_kind is null or namespace_kind in ('GLOBAL_GS1', 'BRAND', 'SUPPLIER', 'SOURCE', 'BELLAROSHE', 'CODE_SYSTEM'));

-- Quién nos lo vendió, separado de quién emite el código.
alter table public.variant_identifiers
  add column if not exists observed_supplier text,
  add column if not exists observed_brand text;

comment on column public.variant_identifiers.observed_supplier is
  'Quién nos vendió este artículo cuando observamos el código. NO es el emisor: '
  'el sistema SS se compra a MAY y a CHINO PUNO, y el código es el mismo.';
comment on column public.variant_identifiers.observed_brand is
  'Qué marca traía el envase al observarlo. LS241 aparece bajo Candy Secret, '
  'bajo ICONSIGN y sin marca: la marca observada no define el namespace.';

-- El prefijo alfabético es el sistema. Solo se aplica cuando existe: un código
-- sin prefijo no revela su sistema, y adivinarlo sería inventar identidad.
update public.variant_identifiers vi
set namespace_kind = 'CODE_SYSTEM',
    namespace_key = upper(substring(vi.value from '^[A-Za-z]+')),
    observed_supplier = vi.namespace_key
where vi.identifier_type = 'SUPPLIER_SKU'
  and vi.namespace_kind = 'SUPPLIER'
  and substring(vi.value from '^[A-Za-z]+') is not null
  and length(substring(vi.value from '^[A-Za-z]+')) >= 2;

-- Los que no tienen prefijo se quedan como estaban pero dicen por qué: su
-- sistema es desconocido, y eso es un hecho útil, no un hueco.
update public.variant_identifiers vi
set observed_supplier = vi.namespace_key,
    metadata = vi.metadata || jsonb_build_object('sistemaDeCodigo', 'INDETERMINADO_SIN_PREFIJO')
where vi.identifier_type = 'SUPPLIER_SKU'
  and vi.namespace_kind = 'SUPPLIER'
  and vi.observed_supplier is null;

-- La marca observada se rellena desde el catálogo, que es donde vive hoy.
update public.variant_identifiers vi
set observed_brand = b.name
from public.product_variants v
join public.products p on p.id = v.product_id
join public.brands b on b.id = p.brand_id
where vi.variant_id = v.id and vi.observed_brand is null;

-- Un mismo código del mismo SISTEMA en dos variantes activas sigue siendo el
-- conflicto que hay que ver; que lo hayan vendido dos proveedores distintos ya
-- no lo esconde.
create or replace view public.variant_identifier_collisions_v1
with (security_invoker = true) as
select
  identifier_type, namespace_kind, namespace_key, value,
  count(*) as variantes,
  array_agg(variant_id order by variant_id) as variant_ids,
  array_agg(distinct observed_supplier) as proveedores_observados,
  array_agg(distinct observed_brand) as marcas_observadas
from public.variant_identifiers
where status = 'active' and namespace_kind <> 'BELLAROSHE'
group by 1, 2, 3, 4
having count(*) > 1;

comment on view public.variant_identifier_collisions_v1 is
  'Mismo código, mismo sistema, dos variantes activas. Enseña también qué '
  'proveedores y marcas se observaron, porque un choque entre proveedores '
  'distintos suele significar que revenden del mismo catálogo de origen.';

commit;
