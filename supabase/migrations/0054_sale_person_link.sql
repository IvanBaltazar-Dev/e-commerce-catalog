-- ---------------------------------------------------------------------------
-- 0054 · La clienta de una venta deja de ser texto suelto
-- ---------------------------------------------------------------------------
-- `sales` guarda `customer_name`, `customer_phone` y `customer_document` como
-- texto libre. Existe `persons` —con esos mismos tres campos— pero ninguna
-- venta apunta a ella, así que hoy «Rosa Díaz» tecleada tres veces son tres
-- clientas distintas, con tres historiales que nunca se juntan.
--
-- Eso choca de frente con la regla de atribución de 0052: el `first_touch` vive
-- en la CLIENTA y cada venta lleva el suyo. Sin identidad estable no hay dónde
-- guardar el primer toque, y no se puede distinguir «Instagram nos trajo una
-- clienta nueva» de «Instagram nos trajo la quinta compra de la misma».
--
-- El texto NO se borra. Sigue siendo el dato de la venta rápida, donde no hay
-- clienta identificada y no debe haberla: obligar a registrar a alguien para
-- cobrar un esmalte es exactamente el formulario que este rediseño quita.
-- `person_id` es opcional a propósito.
-- ---------------------------------------------------------------------------

alter table public.sales
  add column person_id uuid references public.persons (id);

comment on column public.sales.person_id is
  'Clienta identificada, cuando la hay. NULL es un estado legítimo y frecuente: '
  'la venta de mostrador se cobra sin identificar a nadie. El texto de '
  'customer_name/phone/document se conserva como lo que se escribió en su '
  'momento, aunque la ficha de la clienta cambie después.';

create index sales_person_idx on public.sales (person_id, issued_at desc)
  where person_id is not null;

-- ---------------------------------------------------------------------------
-- Buscar una clienta en mostrador
-- ---------------------------------------------------------------------------
-- Un solo cuadro para nombre, celular o documento, porque en mostrador nadie
-- elige antes en qué campo va a buscar. Sin tildes y sin distinguir mayúsculas
-- por el mismo motivo que el buscador de tonos: «Rosa Díaz» se teclea «rosa
-- diaz». El teléfono se compara sin separadores, que es como está guardado y
-- como NO lo dicta la clienta.
-- No hay extensión `unaccent` instalada y 0048 resolvió lo suyo plegando tildes
-- en el navegador. Aquí el filtro va en la base, así que se pliega con
-- `translate`, que es IMMUTABLE y no añade dependencias.
create or replace function public.pos_search_persons(p_query text, p_limit integer default 8)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term text := translate(lower(trim(coalesce(p_query, ''))), 'áéíóúüñ', 'aeiouun');
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_result jsonb;
begin
  if v_term = '' then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
  from (
    select p.id,
           p.full_name        as "fullName",
           p.phone_normalized as "phone",
           p.document_number  as "document"
    from public.persons p
    where p.merged_into_person_id is null
      and (
        translate(lower(p.full_name), 'áéíóúüñ', 'aeiouun') like '%' || v_term || '%'
        -- El teléfono solo se compara si de verdad se tecleó un número: si no,
        -- buscar «Ana» haría match contra cualquier teléfono por la cadena vacía.
        or (v_digits <> '' and coalesce(p.phone_normalized, '') like '%' || v_digits || '%')
        or lower(coalesce(p.document_number, '')) like '%' || v_term || '%'
      )
    order by p.full_name
    limit greatest(1, least(p_limit, 25))
  ) t;

  return v_result;
end;
$$;

comment on function public.pos_search_persons(text, integer) is
  'Busca clientas por nombre, celular o documento con un solo término. La '
  'comparación de teléfono ignora separadores: la clienta dice «999 111 222» y '
  'la vendedora teclea lo que oye.';

-- PostgreSQL concede EXECUTE al rol PUBLIC en toda función nueva, y `anon` es
-- miembro de PUBLIC. 0045 revocó esa concesión sobre las funciones que existían
-- entonces, pero no puede alcanzar a las que nacen después: cada migración tiene
-- que cerrar su propia puerta. Sin este revoke, esta función —que devuelve
-- nombre, celular y documento de cada clienta— queda al alcance de cualquiera
-- con la clave anon, que viaja en el paquete del navegador.
revoke execute on function public.pos_search_persons(text, integer) from public;
grant execute on function public.pos_search_persons(text, integer) to authenticated, service_role;
