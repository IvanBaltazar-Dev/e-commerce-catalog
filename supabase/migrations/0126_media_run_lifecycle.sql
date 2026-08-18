-- 0126 · Una corrida abortada no es evidencia.
--
-- El carril A terminó sus 172 expedientes sin una incidencia y aun así dejó una
-- variante apuntando a un archivo que no era el suyo. El mecanismo importa más
-- que el caso:
--
--   un intento parcial subió un derivado y registró su medio antes de fallar;
--   el reintento buscó ese contenido por hash, lo encontró, y lo interpretó
--   como «otra variante ya tiene esta imagen». Desvinculó el medio editorial
--   legítimo y dejó a la variante colgando del artefacto.
--
-- Es decir: **una ejecución parcial modificó lo que una ejecución posterior
-- interpretó como evidencia válida**. Mientras eso sea posible, ninguna campaña
-- es idempotente por muchos verdes que acumule, porque repetirla sobre sus
-- propios restos no da el mismo resultado.
--
-- El contrato que falta es el ciclo de vida de una corrida:
--
--   STAGED     lo que una corrida produjo y todavía no está autorizado.
--   COMMITTED  resultado autorizado. Solo esto es patrimonio y solo esto
--              participa en deduplicación y auditoría.
--   ABORTED    rastro identificable y saneable, incapaz de decidir nada.
--
-- Buscar un contenido para reutilizarlo deja de significar «existe este hash en
-- media_assets» y pasa a significar «existe este hash en patrimonio válido». Un
-- artefacto se puede detectar para limpiarlo; nunca para decidir de quién es la
-- imagen de una variante.

begin;

create table public.catalog_media_runs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.catalog_media_campaigns(id) on delete cascade,
  lane text not null check (lane in ('A', 'B')),
  state text not null default 'STAGED' check (state in ('STAGED', 'COMMITTED', 'ABORTED')),
  started_at timestamptz not null default now(),
  settled_at timestamptz,
  produced_assets integer not null default 0,
  note text,
  constraint catalog_media_runs_settled_consistent check (
    (state = 'STAGED' and settled_at is null) or (state <> 'STAGED' and settled_at is not null)
  )
);

create index catalog_media_runs_state_idx on public.catalog_media_runs(campaign_id, state);

-- De qué corrida salió cada medio. Nulo significa patrimonio preexistente, que
-- es válido por definición: estaba antes de que ninguna campaña lo tocara.
alter table public.catalog_media_campaign_items
  add column run_id uuid references public.catalog_media_runs(id) on delete set null;

create index catalog_media_campaign_items_run_idx
  on public.catalog_media_campaign_items(run_id) where run_id is not null;

-- Patrimonio válido: todo medio que NO nació de una corrida sin autorizar.
--
-- Un medio preexistente vale. Uno producido por una corrida ya autorizada,
-- también. Uno que solo existe porque una corrida en marcha o abortada lo
-- escribió, no vale como evidencia de nada hasta que su corrida cierre bien.
create or replace view public.catalog_media_valid_patrimony_v1
with (security_invoker = true) as
select asset.*
from public.media_assets asset
where not exists (
  select 1
  from public.catalog_media_campaign_items item
  join public.catalog_media_runs run on run.id = item.run_id
  where item.media_asset_id = asset.id
    and run.state in ('STAGED', 'ABORTED')
    -- El medio no vale como evidencia solo si NINGUNA corrida autorizada lo
    -- respalda. Recuperar en su sitio no lo convierte en artefacto.
    and not exists (
      select 1
      from public.catalog_media_campaign_items confirmed
      join public.catalog_media_runs confirmed_run on confirmed_run.id = confirmed.run_id
      where confirmed.media_asset_id = asset.id and confirmed_run.state = 'COMMITTED'
    )
    and asset.metadata ->> 'recovered' is distinct from 'true'
);

-- Rastros de corridas que no cerraron bien. La limpieza los mira; la
-- deduplicación jamás.
create or replace view public.catalog_media_run_artifacts_v1
with (security_invoker = true) as
select
  asset.id as media_asset_id,
  asset.bucket,
  asset.storage_path,
  asset.checksum,
  run.id as run_id,
  run.lane,
  run.state as run_state,
  run.started_at,
  item.id as campaign_item_id,
  (select count(*) from public.product_media link where link.media_asset_id = asset.id) as asociaciones
from public.media_assets asset
join public.catalog_media_campaign_items item on item.media_asset_id = asset.id
join public.catalog_media_runs run on run.id = item.run_id
where run.state in ('STAGED', 'ABORTED')
  and not exists (select 1 from public.catalog_media_valid_patrimony_v1 valid where valid.id = asset.id);

alter table public.catalog_media_runs enable row level security;
create policy catalog_media_runs_admin_read on public.catalog_media_runs
  for select to authenticated using (public.is_admin());

grant select on public.catalog_media_valid_patrimony_v1 to authenticated, service_role;
grant select on public.catalog_media_run_artifacts_v1 to authenticated, service_role;

commit;
