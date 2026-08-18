-- 0132 · El corte certificado ya lleva las tablas de campaña.
--
-- 0130 las declaró como patrimonio pendiente: eran verdad entonces, porque el
-- único corte disponible era el del 10 de agosto y es anterior a la campaña.
-- Desde que existe un corte certificado del presente, esa deuda está saldada y
-- el contrato tiene que decirlo.
--
-- Importa que sea una migración y no una actualización suelta. El certificador
-- ajustaba el contrato en la base al terminar, y ese ajuste no sobrevivía a un
-- `db reset`: al reconstruir, el contrato volvía a los valores de la migración,
-- la restauración pedía solo veintiséis tablas y las decisiones de la campaña
-- se quedaban fuera sin que nada fallara. Otra vez el mismo patrón —algo que no
-- revienta, solo cuenta de menos— y otra vez lo caza el número que no cuadra.
--
-- El corte del 10 de agosto sigue declarado como `database_checkpoint_baseline`
-- en el manifiesto. No se toca.

begin;

update public.catalog_recovery_contract
set in_baseline_dump = true
where entity in (
  'catalog_media_campaigns',
  'catalog_media_campaign_items',
  'catalog_media_campaign_item_actions',
  'catalog_media_item_states',
  'catalog_media_runs'
);

-- El propio contrato es patrimonio: si se pierde, el sistema deja de saber qué
-- debía recuperar. Entra en el corte como cualquier otra decisión.
insert into public.catalog_recovery_contract (entity, recovery_class, in_checkpoint, in_baseline_dump, rationale)
values (
  'catalog_recovery_contract', 'NOT_REGENERABLE', true, true,
  'Qué debe poder recuperarse y por qué. Perderlo es perder la definición misma de patrimonio.'
)
on conflict (entity) do update set in_baseline_dump = true;

insert into public.catalog_recovery_contract (entity, recovery_class, in_checkpoint, in_baseline_dump, rationale)
values (
  'catalog_media_evidence_classes', 'NOT_REGENERABLE', true, true,
  'Qué clase de evidencia visual admite publicación. Sin esto, los medios recuperados dejan de saber si pueden enseñarse.'
)
on conflict (entity) do update set in_baseline_dump = true;

commit;
