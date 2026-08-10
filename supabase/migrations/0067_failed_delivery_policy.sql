-- ---------------------------------------------------------------------------
-- 0067 · Qué pasa cuando no se pudo entregar
-- ---------------------------------------------------------------------------
-- 0064 creó el estado `failed` y lo dejó alcanzable, pero sin política: la hoja
-- de Pendientes no ofrecía marcarlo porque no estaba decidido qué venía después,
-- y un botón que lleva a un callejón sin salida es peor que no tenerlo.
--
-- LA POLÍTICA, en cuatro reglas:
--
-- 1. NO SE MARCA SIN MOTIVO. «No se pudo entregar» a secas no sirve para
--    decidir nada al día siguiente. Nadie estaba, el número no contesta, la
--    dirección no existe y la clienta se arrepintió llevan a cuatro acciones
--    distintas. El motivo es obligatorio y se guarda con la venta.
--
-- 2. UNA ENTREGA FALLIDA NO TOCA EL DINERO. El adelanto sigue donde estaba y el
--    saldo sigue debiéndose. Devolver el adelanto porque el motorizado no
--    encontró la casa sería decidir por la clienta que ya no quiere su pedido.
--
-- 3. SE REINTENTA HACIA ADELANTE. Desde `failed` se vuelve a `ready` o a
--    `dispatched` —se prepara otra vez, sale otra vez— y así queda registrado
--    que hubo un intento previo. No se «limpia» el fallo: se supera.
--
-- 4. SI NO SE VA A REINTENTAR, LA SALIDA ES ANULAR O DEVOLVER, que ya existen y
--    ya mueven el dinero y el inventario como corresponde. Esta migración NO
--    inventa un tercer camino para deshacer una venta: sería el cuarto sitio
--    donde se decide qué pasa con el dinero de una venta que no llegó.
--
-- Lo que se añade en la base es la regla 1, porque es la única que se puede
-- olvidar desde una pantalla. Las otras tres ya las sostienen los contratos que
-- existen.
-- ---------------------------------------------------------------------------

create or replace function public.mark_sale_fulfillment(
  p_sale_id uuid,
  p_status public.sale_fulfillment_status,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sales%rowtype;
  v_orden constant text[] := array['pending', 'ready', 'dispatched', 'delivered'];
  v_desde integer;
  v_hasta integer;
  v_nota text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if v_sale.id is null then
    raise exception using errcode = '22023', message = 'Esa venta no existe.';
  end if;

  perform public.assert_branch_access(v_sale.branch_id, 'mover una entrega');

  if v_sale.status = 'cancelled' then
    raise exception using errcode = '23514',
      message = 'Esta venta está anulada: ya no hay nada que entregar.';
  end if;

  if v_sale.fulfillment_status = p_status then
    return public.sale_detail(p_sale_id);
  end if;

  if v_sale.fulfillment_status = 'delivered' then
    raise exception using errcode = '23514',
      message = 'Este pedido ya se entregó. Si volvió, lo que corresponde es una devolución.';
  end if;

  -- REGLA 1. Un pedido que no se pudo entregar sin decir por qué es un pedido
  -- que mañana nadie sabe cómo resolver.
  if p_status = 'failed' and v_nota is null then
    raise exception using errcode = '22023',
      message = 'Di por qué no se pudo entregar: mañana hay que decidir si se reintenta o se anula.';
  end if;

  -- REGLA 3. `failed` se alcanza desde cualquier punto anterior a la entrega, y
  -- desde `failed` se reintenta hacia adelante: un timbre al que nadie contesta
  -- no es el final del pedido.
  if p_status <> 'failed' and v_sale.fulfillment_status <> 'failed' then
    v_desde := array_position(v_orden, v_sale.fulfillment_status::text);
    v_hasta := array_position(v_orden, p_status::text);
    if v_hasta < v_desde then
      raise exception using errcode = '23514',
        message = 'Un pedido no vuelve atrás en su entrega: corrige lo que esté mal y avanza.';
    end if;
  end if;

  update public.sales
  set fulfillment_status = p_status,
      -- El motivo se acumula, no se pisa: dos intentos fallidos por motivos
      -- distintos cuentan una historia que un solo campo sobrescrito pierde.
      notes = case
        when v_nota is null then notes
        else btrim(coalesce(notes || E'\n', '') || v_nota)
      end,
      updated_at = now()
  where id = p_sale_id;

  return public.sale_detail(p_sale_id);
end;
$$;

comment on function public.mark_sale_fulfillment(uuid, public.sale_fulfillment_status, text) is
  'Mueve el pedido por sus estados de entrega. No toca el cobro: se puede '
  'entregar sin haber cobrado y cobrar sin haber entregado. Marcar `failed` '
  'exige motivo, porque de él depende qué se hace después.';

revoke execute on function public.mark_sale_fulfillment(uuid, public.sale_fulfillment_status, text) from public;
grant execute on function public.mark_sale_fulfillment(uuid, public.sale_fulfillment_status, text) to authenticated, service_role;
