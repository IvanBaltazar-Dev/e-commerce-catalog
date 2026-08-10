-- ---------------------------------------------------------------------------
-- 0068 · El comprobante pide LO SUYO, y nunca hereda el documento de nadie
-- ---------------------------------------------------------------------------
-- Los datos tributarios son el cuarto rol de una venta y el único que seguía sin
-- reglas propias. Hasta aquí:
--
--   · La factura tenía una restricción escrita a mano en 0029 —RUC de 11 dígitos
--     y razón social— y la boleta no tenía ninguna. Se podía pedir una boleta sin
--     un solo dato y quedaba registrada como pedida.
--   · `request_tax_document` no comprobaba nada: aceptaba lo que le llegara y lo
--     insertaba. Lo que fallaba lo hacía la restricción, con el mensaje crudo de
--     PostgreSQL.
--
-- LO QUE ESTA MIGRACIÓN NO HACE, a propósito: emitir. No hay integración con
-- SUNAT ni la pretende. Lo que se registra es una SOLICITUD —qué comprobante
-- quiere la clienta y a nombre de quién— y su ciclo sigue siendo el de 0029:
-- solicitado → emitido fuera → con su referencia externa. La nota de venta sigue
-- diciendo en letra grande que no es comprobante autorizado.
--
-- DOS DECISIONES:
--
-- 1. LOS REQUISITOS SON DATOS, como los de entrega (0060) y los del adelanto
--    (0064). Y aquí importa más que en ningún otro sitio, porque son reglas de
--    un tercero: el día que la SUNAT cambie el umbral de la boleta, cambia una
--    fila y no una migración.
--
-- 2. EL DOCUMENTO NO SE HEREDA. Ni el de la compradora, ni el del destinatario,
--    ni el de quien recoge. La pantalla puede OFRECER copiar el de la clienta
--    —es un atajo honesto, la mayoría de boletas van a su nombre— pero tiene que
--    ser un gesto de quien vende, no un relleno automático. Una factura a nombre
--    de la empresa donde trabaja la clienta lleva un RUC que no es de ninguna de
--    las personas que aparecen en la venta.
-- ---------------------------------------------------------------------------

create table public.tax_document_requirements (
  kind public.tax_document_kind primary key,
  /* Cómo se llama el identificador en pantalla. No es cosmético: pedir «RUC»
     cuando toca DNI hace que quien vende teclee once dígitos de la empresa en el
     comprobante de una persona. */
  tax_id_label text not null,
  tax_id_pattern text not null,
  /* Importe a partir del cual el identificador deja de ser opcional. Cero es
     «siempre hace falta». La boleta lo necesita desde S/ 700, que es la regla
     vigente y la razón entera de que esta columna exista. */
  tax_id_required_from numeric(12, 2),
  requires_name boolean not null default false,
  requires_address boolean not null default false,
  hint text,
  updated_at timestamptz not null default now()
);

comment on table public.tax_document_requirements is
  'Qué exige cada comprobante. Son reglas de un tercero —la SUNAT— y por eso son '
  'datos: cuando cambie el umbral de la boleta se cambia una fila.';

comment on column public.tax_document_requirements.tax_id_required_from is
  'Desde qué importe el identificador es obligatorio. Cero: siempre. NULL: '
  'nunca, ni siquiera opcionalmente.';

insert into public.tax_document_requirements
  (kind, tax_id_label, tax_id_pattern, tax_id_required_from, requires_name, requires_address, hint) values
  -- La factura es para una empresa: RUC, razón social y dirección fiscal, sin
  -- importar el importe.
  ('invoice', 'RUC', '^[0-9]{11}$', 0, true, true,
   'Una factura va a nombre de una empresa: RUC de 11 dígitos, razón social y dirección fiscal.'),
  -- La boleta va a una persona. Por debajo de S/ 700 no hace falta identificarla
  -- —y pedirle el DNI para un esmalte es fricción inventada—; desde ahí, sí.
  ('sales_receipt', 'DNI', '^[0-9]{8}$', 700, false, false,
   'Desde S/ 700 la boleta necesita el DNI de la clienta.');

alter table public.tax_document_requirements enable row level security;

-- La lee todo el personal: la pantalla necesita saber qué pedir antes de
-- registrar la solicitud.
create policy "staff read tax document requirements"
  on public.tax_document_requirements
  for select to authenticated
  using (public.is_staff());

-- Ajustarla es decisión de administración, igual que los requisitos de entrega.
create policy "admins adjust tax document requirements"
  on public.tax_document_requirements
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant update on public.tax_document_requirements to authenticated;

-- ---------------------------------------------------------------------------
-- La regla, en un solo sitio
-- ---------------------------------------------------------------------------
/**
 * Qué le falta a una solicitud de comprobante, o null si está completa.
 *
 * La consulta la pantalla para pedirlo antes y el contrato para impedirlo
 * después. Depende del IMPORTE porque una de las reglas lo hace: la misma boleta
 * es válida sin DNI por S/ 300 e inválida sin él por S/ 800.
 */
create or replace function public.tax_document_problem(
  p_kind public.tax_document_kind,
  p_total numeric,
  p_receiver jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_req public.tax_document_requirements%rowtype;
  v_tax_id text := nullif(btrim(coalesce(p_receiver ->> 'taxId', '')), '');
  v_name text := nullif(btrim(coalesce(p_receiver ->> 'name', '')), '');
  v_address text := nullif(btrim(coalesce(p_receiver ->> 'address', '')), '');
  v_exigido boolean;
begin
  select * into v_req from public.tax_document_requirements where kind = p_kind;

  if v_req.kind is null then
    return 'Ese comprobante no se emite aquí: la nota de venta cubre el resto.';
  end if;

  v_exigido := v_req.tax_id_required_from is not null
               and coalesce(p_total, 0) >= v_req.tax_id_required_from;

  if v_exigido and v_tax_id is null then
    return format('Falta el %s de quien recibe el comprobante.', v_req.tax_id_label);
  end if;

  -- Si lo dan, tiene que ser válido: un RUC de nueve dígitos no lo rechaza la
  -- pantalla, lo rechaza la SUNAT tres días después.
  if v_tax_id is not null and v_tax_id !~ v_req.tax_id_pattern then
    return format('El %s no tiene el formato correcto.', v_req.tax_id_label);
  end if;

  if v_req.requires_name and v_name is null then
    return 'Falta el nombre o la razón social a la que va el comprobante.';
  end if;

  if v_req.requires_address and v_address is null then
    return 'Falta la dirección fiscal.';
  end if;

  return null;
end;
$$;

comment on function public.tax_document_problem(public.tax_document_kind, numeric, jsonb) is
  'Qué le falta a una solicitud de comprobante. Única definición: la consulta la '
  'pantalla para pedirlo antes y request_tax_document para impedirlo después.';

revoke execute on function public.tax_document_problem(public.tax_document_kind, numeric, jsonb) from public;
grant execute on function public.tax_document_problem(public.tax_document_kind, numeric, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- El contrato consulta la regla en vez de dejar que reviente la restricción
-- ---------------------------------------------------------------------------
create or replace function public.request_tax_document(
  p_sale_id uuid,
  p_kind public.tax_document_kind,
  p_receiver jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  sale public.sales%rowtype;
  problema text;
begin
  select * into sale from public.sales where id = p_sale_id;

  if sale.id is null then
    raise exception using errcode = '22023', message = 'La venta no existe.';
  end if;

  perform public.assert_branch_access(sale.branch_id, 'solicitar comprobantes');

  if sale.status = 'cancelled' then
    raise exception using errcode = '23514',
      message = 'Esta venta está anulada: no se emite comprobante de algo que no se vendió.';
  end if;

  -- El importe manda en la regla de la boleta, y el importe es el de la venta:
  -- no se pregunta ni se recibe de fuera.
  problema := public.tax_document_problem(p_kind, sale.total, p_receiver);
  if problema is not null then
    raise exception using errcode = '22023', message = problema;
  end if;

  insert into public.tax_document_requests (
    sale_id, kind, receiver_tax_id, receiver_name, receiver_address,
    requested_by, requested_by_label
  ) values (
    p_sale_id, p_kind,
    nullif(trim(coalesce(p_receiver ->> 'taxId', '')), ''),
    nullif(trim(coalesce(p_receiver ->> 'name', '')), ''),
    nullif(trim(coalesce(p_receiver ->> 'address', '')), ''),
    auth.uid(),
    (select nullif(trim(coalesce(full_name, '')), '') from public.admin_profiles where id = auth.uid())
  )
  on conflict (sale_id) do update set
    kind = excluded.kind,
    status = 'requested',
    receiver_tax_id = excluded.receiver_tax_id,
    receiver_name = excluded.receiver_name,
    receiver_address = excluded.receiver_address,
    requested_at = now(),
    resolved_at = null;

  return public.sale_detail(p_sale_id);
end;
$$;

comment on function public.request_tax_document(uuid, public.tax_document_kind, jsonb) is
  'Registra QUÉ comprobante quiere la clienta y a nombre de quién. No emite '
  'nada: la emisión es externa y su ciclo lo lleva tax_document_requests. Los '
  'datos del receptor son suyos y no se heredan de la compradora ni de quien '
  'recibe el pedido.';

revoke execute on function public.request_tax_document(uuid, public.tax_document_kind, jsonb) from public;
grant execute on function public.request_tax_document(uuid, public.tax_document_kind, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- La segunda puerta
-- ---------------------------------------------------------------------------
-- La restricción de 0029 llevaba el patrón del RUC escrito a mano, así que había
-- dos sitios donde decir qué es un RUC válido. Se retira y su trabajo pasa a un
-- disparador que consulta la fila: una restricción CHECK no puede leer otra
-- tabla, y un disparador sí.
alter table public.tax_document_requests
  drop constraint tax_document_requests_invoice_needs_tax_id;
create or replace function public.assert_tax_document_receiver()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total numeric(12, 2);
  problema text;
begin
  select total into v_total from public.sales where id = new.sale_id;

  problema := public.tax_document_problem(
    new.kind,
    v_total,
    jsonb_build_object(
      'taxId', new.receiver_tax_id,
      'name', new.receiver_name,
      'address', new.receiver_address
    )
  );

  if problema is not null then
    raise exception using errcode = '23514', message = problema;
  end if;

  return null;
end;
$$;

revoke execute on function public.assert_tax_document_receiver() from public;

create constraint trigger tax_document_receiver_complete
  after insert or update on public.tax_document_requests
  deferrable initially deferred
  for each row
  execute function public.assert_tax_document_receiver();
