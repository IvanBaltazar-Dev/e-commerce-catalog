-- El enriquecimiento tiene que sobrevivir a que el snapshot cambie.
--
-- La prueba es de ida y vuelta y se revierte entera: se borra el valor de la capa
-- de referencia —simulando lo que hace una recaptura— y se comprueba que puede
-- reponerse desde catalog_enrichment_facts sin pedir nada a internet.
--
-- Si esto fallara significaría que el dato vuelve a colgar del snapshot, y la
-- siguiente recarga lo perdería otra vez en silencio.
\set ON_ERROR_STOP on
begin;

-- Estado de partida
select count(*) as hechos_de_enriquecimiento from catalog_enrichment_facts where superseded_at is null;

create temp table antes as
select v.id, v.barcode
from catalog_reference_variants v
where v.barcode is not null and v.superseded_at is null;

select count(*) as variantes_con_barcode_antes from antes;

-- Simular la recaptura: la capa de referencia pierde el dato
update catalog_reference_variants set barcode = null
where id in (select id from antes);

select count(*) as tras_la_recaptura from catalog_reference_variants
where barcode is not null and superseded_at is null;

-- Y reponerlo SOLO desde el enriquecimiento, cruzando por identidad
update catalog_reference_variants v
set barcode = e.value
from catalog_source_records r, catalog_enrichment_facts e
where v.primary_source_record_id = r.id
  and e.source_id = r.source_id
  and e.entity_kind = r.entity_type
  and e.external_id = split_part(r.external_id, ':', 2)
  and e.field = 'barcode'
  and e.superseded_at is null
  and v.barcode is null;

select count(*) as repuestas from catalog_reference_variants v
join antes a on a.id = v.id where v.barcode = a.barcode;

select count(*) as perdidas from antes a
join catalog_reference_variants v on v.id = a.id
where v.barcode is distinct from a.barcode;

rollback;
