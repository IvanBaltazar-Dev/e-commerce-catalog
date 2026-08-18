-- 0129 · El detector mira tablas, no vistas.
--
-- La primera versión señaló cuatro huecos y dos eran vistas: una proyección no
-- guarda nada, solo lo enseña. Restaurar una vista no tiene sentido y exigirlo
-- convertiría el gate en ruido.
--
-- Lo que queda tras afinarlo son huecos de verdad, y conviene decirlos por su
-- nombre en vez de clasificarlos deprisa para que el gate se ponga verde:
--
--   catalog_reconciliation_cases     guarda `decision_reason`, `decided_by` y
--                                    `decided_at`. Una aprobación es un juicio.
--                                    Hoy se regenera desde el corte de
--                                    investigación, y al regenerarse vuelve a
--                                    `needs_review`: la aprobación se pierde.
--   catalog_relation_decisions       lo mismo para las 18 decisiones agrupadas.
--
-- No se resuelven aquí. Se declaran como lo que son —patrimonio no regenerable
-- que todavía no está en el checkpoint— para que el gate lo diga en voz alta.
-- Clasificarlas como regenerables sería mentir; incluirlas sin más cambiaría el
-- contrato del checkpoint por la puerta de atrás.

begin;

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
  'declarar en catalog_recovery_contract con su clase y su motivo' as remedy
from decision_bearing candidate
left join public.catalog_recovery_contract contract on contract.entity = candidate.table_name
where contract.entity is null
union all
select
  contract.entity,
  'declarado NO REGENERABLE y todavía fuera del checkpoint' as gap,
  'incluirlo en el corte certificado siguiente' as remedy
from public.catalog_recovery_contract contract
where contract.recovery_class = 'NOT_REGENERABLE' and not contract.in_checkpoint;

insert into public.catalog_recovery_contract (entity, recovery_class, in_checkpoint, rationale) values
  ('catalog_reconciliation_cases', 'NOT_REGENERABLE', false,
   'Una aprobación de identidad lleva quién y cuándo. Al regenerarse desde el corte de investigación vuelve a needs_review y el juicio se pierde. Pendiente de incorporar al corte certificado.'),
  ('catalog_relation_decisions', 'NOT_REGENERABLE', false,
   'Las decisiones agrupadas de relaciones. Se conservan deliberadamente sin aplicar; su estado es información, no un derivado.'),
  ('catalog_review_events', 'NOT_REGENERABLE', false,
   'El historial de la Mesa: quién resolvió qué y con qué evidencia. No se recalcula.')
on conflict (entity) do nothing;

commit;
