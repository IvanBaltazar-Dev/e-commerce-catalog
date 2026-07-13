begin;

-- Preserva la opción exacta del panel admin (No / Sí / UV/LED).
-- requires_lamp se mantiene por compatibilidad y se deriva de lamp_type.
alter table public.products
  add column if not exists lamp_type text not null default 'No';

update public.products
set lamp_type = case when requires_lamp then 'Sí' else 'No' end;

alter table public.products
  add constraint products_lamp_type_allowed
  check (lamp_type in ('No', 'Sí', 'UV/LED'));

commit;
