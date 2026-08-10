-- ---------------------------------------------------------------------------
-- 0065 · El número de operación, una sola regla para todo el dinero que entra
-- ---------------------------------------------------------------------------
-- 0057 estableció que Yape, Plin, transferencia y tarjeta no se registran sin su
-- número de operación, porque sin él un descuadre de caja no se puede rastrear
-- hasta el movimiento real. Pero lo escribió SOLO sobre `sale_payments`.
--
-- `reservation_payments` quedó fuera, y ahí entra dinero exactamente igual: el
-- adelanto de una reserva. En la base local, las tres reservas con adelanto por
-- Yape están las tres sin código. El agujero no es teórico — es la puerta por la
-- que se cuela justo lo que 0057 vino a cerrar, y encima por el sitio más
-- incómodo: un adelanto es dinero que entra hoy y se aplica semanas después.
--
-- DOS DECISIONES:
--
-- 1. LA REGLA SE ESCRIBE UNA VEZ. Hasta aquí vivía copiada dentro de una
--    restricción; añadir la segunda copia habría creado el problema clásico de
--    dos listas de medios que un día dejan de coincidir. Pasa a una función que
--    las dos restricciones consultan.
--
-- 2. LAS FILAS VIEJAS NO SE REESCRIBEN NI SE BORRAN. La restricción de
--    `reservation_payments` entra como NOT VALID: lo que ya está escrito se
--    queda como está —es historia, y un código inventado a posteriori es peor
--    que un hueco honesto— y todo lo que se escriba desde ahora sí cumple. Es
--    literalmente lo que 0057 dijo que correspondía hacer con los datos viejos.
-- ---------------------------------------------------------------------------

/**
 * Qué medios de pago no se registran sin su número de operación.
 *
 * El efectivo no lleva porque no existe. `reservation_advance` tampoco: esa fila
 * la genera la conversión de una reserva y arrastra el pago original, que ya
 * trae el suyo. `store_credit` y `other` quedan libres a propósito — exigir un
 * código que no existe empuja a inventarlo, y un dato inventado es peor que un
 * dato ausente.
 *
 * IMMUTABLE porque una restricción CHECK lo exige: el resultado depende solo del
 * argumento y no cambia nunca para el mismo medio.
 */
create or replace function public.payment_requires_reference(p_method public.payment_method)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_method in ('yape', 'plin', 'transfer', 'card');
$$;

comment on function public.payment_requires_reference(public.payment_method) is
  'Única definición de qué medios exigen número de operación. La consultan la '
  'restricción de sale_payments y la de reservation_payments; el equivalente en '
  'la aplicación es requiresOperationNumber() en lib/admin/sales.ts, y las dos '
  'listas están fijadas por prueba.';

revoke execute on function public.payment_requires_reference(public.payment_method) from public;
grant execute on function public.payment_requires_reference(public.payment_method) to authenticated, service_role;

-- La restricción de 0057 pasa a consultar la regla en vez de repetirla. Es la
-- misma condición, palabra por palabra, escrita en un solo sitio.
alter table public.sale_payments
  drop constraint sale_payments_reference_required;

alter table public.sale_payments
  add constraint sale_payments_reference_required
  check (
    not public.payment_requires_reference(method)
    or nullif(btrim(coalesce(reference, '')), '') is not null
  );

comment on constraint sale_payments_reference_required on public.sale_payments is
  'Yape, Plin, transferencia y tarjeta no se registran sin su número de '
  'operación: sin él, un descuadre de caja no se puede rastrear hasta el '
  'movimiento real. El efectivo no lleva número porque no lo tiene.';

-- Y el adelanto de una reserva, que hasta hoy no la tenía.
alter table public.reservation_payments
  add constraint reservation_payments_reference_required
  check (
    not public.payment_requires_reference(method)
    or nullif(btrim(coalesce(reference, '')), '') is not null
  )
  not valid;

comment on constraint reservation_payments_reference_required on public.reservation_payments is
  'La misma regla que en sale_payments: un adelanto por Yape sin su código es '
  'dinero que entró y no se puede rastrear. NOT VALID a propósito: los '
  'adelantos ya registrados se conservan como están, y todo lo nuevo cumple.';

-- Buscar un adelanto por su código es lo mismo que se hace con un cobro cuando
-- la caja no cuadra, y hasta ahora habría sido un recorrido secuencial.
create index reservation_payments_reference_idx
  on public.reservation_payments (reference)
  where reference is not null;
