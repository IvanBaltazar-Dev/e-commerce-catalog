-- 0130 · Lo que el patrimonio exige y lo que el corte histórico ya lleva.
--
-- Declarar las tablas de campaña como patrimonio recuperable hizo lo que tenía
-- que hacer: la restauración se negó a continuar porque el volcado no las
-- contiene. Es la señal correcta, pero confunde dos preguntas distintas:
--
--   ¿esta entidad DEBE poder recuperarse?    → sí, es un juicio, no un cálculo
--   ¿el corte del 10 de agosto YA la lleva?  → no, es anterior a la campaña
--
-- El corte del 10 de agosto se queda como está. Es una evidencia histórica
-- inmutable y acaba de demostrar algo que no queremos perder: desde ese estado,
-- el carril A reproduce exactamente el mismo alcance y el mismo patrimonio.
-- Regenerarlo para tapar este hueco borraría justamente la prueba.
--
-- Así que el contrato pasa a decir las dos cosas por separado. La restauración
-- exige solo lo que el corte vigente lleva; el gate señala la diferencia como
-- deuda con nombre, hasta que un corte certificado posterior la absorba.

begin;

alter table public.catalog_recovery_contract
  add column in_baseline_dump boolean not null default true;

comment on column public.catalog_recovery_contract.in_checkpoint is
  'La entidad forma parte del patrimonio que debe poder recuperarse.';
comment on column public.catalog_recovery_contract.in_baseline_dump is
  'El corte vigente ya la contiene. Falso significa deuda declarada, no error.';

-- Las tablas de campaña son patrimonio desde hoy y entran en el corte
-- siguiente, no en el histórico.
update public.catalog_recovery_contract
set in_baseline_dump = false
where entity in (
  'catalog_media_campaigns',
  'catalog_media_campaign_items',
  'catalog_media_campaign_item_actions',
  'catalog_media_item_states',
  'catalog_media_runs'
);

create or replace view public.catalog_recovery_contract_gaps_v1
with (security_invoker = true) as
with decision_bearing as (
  select distinct columns.table_name
  from information_schema.columns
  join information_schema.tables
    on tables.table_schema = columns.table_schema
   and tables.table_name = columns.table_name
   and tables.table_type = 'BASE TABLE'
  where columns.table_schema = 'public'
    and columns.column_name in ('cause', 'resolution_code', 'decision_reason', 'defer_reason')
)
select
  candidate.table_name as entity,
  'guarda decisiones o causas y no está en el contrato de recuperación' as gap,
  'declarar en catalog_recovery_contract con su clase y su motivo' as remedy,
  true as blocks_gate_d
from decision_bearing candidate
left join public.catalog_recovery_contract contract on contract.entity = candidate.table_name
where contract.entity is null
union all
select
  contract.entity,
  'patrimonio declarado que el corte vigente todavía no lleva' as gap,
  'incorporar en el corte certificado posterior a la campaña' as remedy,
  true as blocks_gate_d
from public.catalog_recovery_contract contract
where contract.recovery_class = 'NOT_REGENERABLE'
  and (not contract.in_checkpoint or not contract.in_baseline_dump);

commit;
