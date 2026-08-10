-- ---------------------------------------------------------------------------
-- 0060 · Los roles de una venta dejan de compartir un solo campo
-- ---------------------------------------------------------------------------
-- Hoy `sales` tiene UN juego de datos de persona —customer_name, customer_phone,
-- customer_document, delivery_address— que intenta responder cuatro preguntas
-- distintas a la vez:
--
--   ¿quién compra?      → historial, recurrencia, reservas
--   ¿quién recibe?      → a quién y a dónde se entrega
--   ¿quién recoge?      → a quién se le acredita el retiro
--   ¿a nombre de quién   → los datos del comprobante
--    va la boleta?
--
-- Son personas que pueden ser distintas. Una clienta compra y pide que se lo
-- lleven a su hermana; un motorizado recoge por ella; la factura va a nombre de
-- la empresa donde trabaja. Con un solo `customer_document` cualquiera de esos
-- casos obliga a pisar el dato de otro, y el que se pisa se pierde.
--
-- Esta migración NO borra los campos viejos. Siguen siendo la instantánea de la
-- COMPRADORA tal como se escribió al vender, que es lo que imprime la nota.
-- Lo que se añade es el resto de roles, cada uno con su propia identidad.
--
-- Decisión de alcance: el receptor fiscal NO entra aquí. Ya vive en
-- `tax_document_requests` con su ciclo propio (solicitado → emitido) y su
-- referencia externa; moverlo sería romper algo que funciona para ganar
-- simetría, que es mal cambio.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Los roles
-- ---------------------------------------------------------------------------
create type public.sale_party_role as enum (
  'recipient',           -- a quién se le entrega el pedido
  'pickup_authorized'    -- quién está autorizado a retirarlo en tienda
);

comment on type public.sale_party_role is
  'Roles OPERATIVOS de una venta: los que hacen falta para cumplir la entrega. '
  'La compradora no está aquí porque es una identidad, no un contacto de esta '
  'entrega: vive en sales.person_id. El receptor fiscal tampoco: vive en '
  'tax_document_requests, que tiene ciclo de vida propio.';

create table public.sale_parties (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  role public.sale_party_role not null,

  -- Cuando quien recibe SÍ está registrado —la propia clienta u otra persona
  -- con ficha— se enlaza. Cuando no, se guardan sus datos sueltos y ya está:
  -- obligar a crear una ficha para poder entregar un pedido es la fricción que
  -- este diseño evita.
  person_id uuid references public.persons (id),

  full_name text,
  phone text,
  document_number text,
  address text,
  notes text,

  /* Marca que este rol lo cumple la misma compradora. No se deduce comparando
     nombres —dos «Rosa Díaz» no son la misma— y permite que la pantalla diga
     «Recibe: la clienta» sin copiar sus datos a la entrega. */
  is_buyer boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Un solo destinatario y un solo autorizado por venta: si hicieran falta dos,
  -- son dos entregas, y eso es otro modelo.
  constraint sale_parties_unique_role unique (sale_id, role),

  -- Tres maneras válidas de decir quién es: enlazar su ficha, escribir sus datos
  -- sueltos, o declarar que es la propia compradora —y entonces quien la
  -- identifica es la venta—. Una fila sin ninguna de las tres no identifica a
  -- nadie y no debería existir.
  --
  -- `is_buyer` tiene que contar como identificación o se contradice consigo
  -- mismo: existe justamente para poder decir «recibe la clienta» SIN copiar sus
  -- datos, y una comprobación que exigiera ficha o nombre rechazaría esa fila.
  constraint sale_parties_identifiable check (
    is_buyer
    or person_id is not null
    or nullif(btrim(coalesce(full_name, '')), '') is not null
  )
);

comment on table public.sale_parties is
  'Quién recibe o recoge una venta, cuando no es un dato de la compradora. Sus '
  'datos pertenecen a ESTA entrega: no completan ni modifican la ficha de la '
  'clienta si se trata de otra persona.';

comment on column public.sale_parties.is_buyer is
  'true cuando el rol lo cumple la propia compradora. La pantalla lo usa para no '
  'volver a pedir lo que ya sabe.';

create index sale_parties_sale_idx on public.sale_parties (sale_id);
create index sale_parties_person_idx on public.sale_parties (person_id)
  where person_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Qué exige cada método de cumplimiento — como DATO, no quemado en código
-- ---------------------------------------------------------------------------
-- Ivan fue explícito: no grabar «delivery ⇒ DNI obligatorio» como regla
-- universal si el negocio no lo necesita para entregar. Cada método declara sus
-- requisitos aquí y la dueña puede ajustarlos sin migración; la validación los
-- lee en vez de repetirlos.
create table public.fulfillment_requirements (
  method public.fulfillment_method primary key,
  requires_recipient boolean not null default false,
  requires_phone boolean not null default false,
  requires_address boolean not null default false,
  requires_document boolean not null default false,
  /* Qué se le dice a quien vende cuando falta algo. Vive con la regla para que
     el mensaje no se desincronice de lo que de verdad se exige. */
  hint text,
  updated_at timestamptz not null default now()
);

comment on table public.fulfillment_requirements is
  'Qué datos exige cada método de entrega. Es configuración, no código: si '
  'mañana el reparto propio deja de necesitar documento, se cambia una fila.';

insert into public.fulfillment_requirements
  (method, requires_recipient, requires_phone, requires_address, requires_document, hint) values
  -- En tienda se entrega en el mostrador, a quien está delante. No hace falta
  -- saber su nombre para darle su bolsa.
  ('in_store',       false, false, false, false, null),
  -- Recojo: hace falta saber a quién se le va a entregar cuando venga, porque
  -- quien viene puede no ser quien compró. El documento NO se exige por defecto:
  -- se activa aquí el día que la dueña decida acreditar identidad al retirar.
  ('pickup',         true,  false, false, false,
   'Di quién va a recoger el pedido.'),
  -- Reparto propio: sin dirección no hay a dónde ir, y sin teléfono no se puede
  -- avisar ni resolver cuando nadie abre la puerta.
  ('local_delivery', true,  true,  true,  false,
   'Un delivery necesita a quién se le entrega, un teléfono de contacto y la dirección.'),
  -- Envío a provincia: la agencia sí exige documento del destinatario para
  -- liberar el paquete, y por eso aquí sí está activado.
  ('shipping',       true,  true,  true,  true,
   'Un envío necesita destinatario con documento, teléfono y dirección: la agencia lo pide para entregar.');

-- ---------------------------------------------------------------------------
-- 3. La regla, en un solo sitio, que consumen pantalla y base
-- ---------------------------------------------------------------------------
-- Devuelve qué falta para cumplir una venta. La pantalla la llama para pedirlo
-- ANTES; el trigger la llama para impedirlo DESPUÉS. Una sola definición: si
-- mañana cambian los requisitos, no hay dos sitios que puedan discrepar.
create or replace function public.sale_fulfillment_gaps(p_sale_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sale public.sales%rowtype;
  v_req public.fulfillment_requirements%rowtype;
  v_party public.sale_parties%rowtype;
  v_name text;
  v_phone text;
  v_document text;
  v_gaps text[] := '{}';
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if v_sale.id is null then
    return v_gaps;
  end if;

  select * into v_req from public.fulfillment_requirements where method = v_sale.fulfillment_method;
  if v_req.method is null then
    return v_gaps;
  end if;

  select * into v_party
  from public.sale_parties
  where sale_id = p_sale_id
    and role = case when v_sale.fulfillment_method = 'pickup'
                    then 'pickup_authorized'::public.sale_party_role
                    else 'recipient'::public.sale_party_role end;

  -- Los datos del rol mandan; si el rol lo cumple la compradora y no se
  -- repitieron, se caen a lo que se sabe de ella. Así «Recibe: la clienta» no
  -- obliga a copiar sus datos en la entrega.
  if v_party.id is not null then
    v_name := coalesce(
      nullif(btrim(coalesce(v_party.full_name, '')), ''),
      (select p.full_name from public.persons p where p.id = v_party.person_id),
      case when v_party.is_buyer then nullif(btrim(coalesce(v_sale.customer_name, '')), '') end
    );
    v_phone := coalesce(
      nullif(btrim(coalesce(v_party.phone, '')), ''),
      (select p.phone_normalized from public.persons p where p.id = v_party.person_id),
      case when v_party.is_buyer then nullif(btrim(coalesce(v_sale.customer_phone, '')), '') end
    );
    v_document := coalesce(
      nullif(btrim(coalesce(v_party.document_number, '')), ''),
      (select p.document_number from public.persons p where p.id = v_party.person_id),
      case when v_party.is_buyer then nullif(btrim(coalesce(v_sale.customer_document, '')), '') end
    );
  end if;

  if v_req.requires_recipient and v_name is null then
    v_gaps := v_gaps || 'recipient'::text;
  end if;
  if v_req.requires_phone and v_phone is null then
    v_gaps := v_gaps || 'phone'::text;
  end if;
  if v_req.requires_document and v_document is null then
    v_gaps := v_gaps || 'document'::text;
  end if;
  -- La dirección es de la ENTREGA, nunca de la ficha de nadie: una persona puede
  -- pedir a su casa hoy y a su trabajo mañana.
  if v_req.requires_address
     and nullif(btrim(coalesce(v_party.address, v_sale.delivery_address, '')), '') is null then
    v_gaps := v_gaps || 'address'::text;
  end if;

  return v_gaps;
end;
$$;

comment on function public.sale_fulfillment_gaps(uuid) is
  'Qué le falta a una venta para poder cumplirse, según su método de entrega. '
  'Única definición de la regla: la pantalla la consulta para pedirlo antes y el '
  'trigger para impedirlo después.';

revoke execute on function public.sale_fulfillment_gaps(uuid) from public;
grant execute on function public.sale_fulfillment_gaps(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Las dos puertas: política Y privilegio
-- ---------------------------------------------------------------------------
-- La doctrina del repositorio —y lo que comprueba `npm run audit:security`— es
-- que NINGUNA tabla de `public` vive sin RLS. No es formalismo: las tablas nacen
-- con SELECT concedido a `authenticated` por los privilegios por defecto del
-- esquema, así que sin política activa la tabla queda legible por cualquiera con
-- sesión iniciada, sin importar su sede ni su rol.
--
-- Y lo que hay aquí dentro es el nombre, el celular, el documento y la dirección
-- de gente que ni siquiera compró: la hermana a la que se le manda el pedido, el
-- motorizado que lo recoge. Merece el mismo cuidado que la caja.

alter table public.sale_parties enable row level security;

-- El mismo alcance que `sale_lines`, `sale_payments` y `tax_document_requests`:
-- se ve lo de las sedes donde una trabaja, y nada más. Quien vende en Surco no
-- tiene por qué leer a dónde se entrega en Miraflores.
create policy "staff read sale parties"
  on public.sale_parties
  for select
  to authenticated
  using (
    exists (
      select 1 from public.sales s
      where s.id = sale_parties.sale_id
        and s.branch_id in (select public.staff_branch_ids())
    )
  );

-- No hay política de escritura a propósito: estas filas las escribe la venta,
-- desde una función SECURITY DEFINER, igual que las líneas y los pagos. Nadie
-- edita a mano a quién se le entrega un pedido ya registrado.

alter table public.fulfillment_requirements enable row level security;

-- La regla la lee todo el personal —la pantalla necesita saber qué pedir antes
-- de cobrar— y no está partida por sede: es la misma para toda la operación.
create policy "staff read fulfillment requirements"
  on public.fulfillment_requirements
  for select
  to authenticated
  using (public.is_staff());

-- Cambiarla sí es decisión de la dueña. El comentario de la tabla promete que se
-- ajusta «sin migración»; esta política es lo que hace verdadera la promesa.
create policy "admins adjust fulfillment requirements"
  on public.fulfillment_requirements
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant update on public.fulfillment_requirements to authenticated;
