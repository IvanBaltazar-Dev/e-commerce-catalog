-- ---------------------------------------------------------------------------
-- 0057 · Yape, Plin, transferencia y tarjeta exigen número de operación
-- ---------------------------------------------------------------------------
-- `sale_payments.reference` ya existía, pero era opcional para TODOS los medios
-- y nada la pedía en pantalla. En la práctica eso significa que un cobro por
-- Yape se registraba sin su código, y cuando al cierre de caja el monto no
-- cuadra no hay forma de encontrar la operación en la app del banco: queda la
-- palabra de quien cobró contra el extracto.
--
-- El efectivo NO lleva número, porque no existe. `reservation_advance` tampoco:
-- esa fila la genera la conversión de una reserva y arrastra el pago original,
-- que ya trae el suyo. `store_credit` y `other` quedan libres a propósito —
-- exigir un código que no existe empuja a inventarlo, y un dato inventado es
-- peor que un dato ausente.
--
-- Se aplica por CHECK y no por validación en el frontend: la regla tiene que
-- valer también para el asistente, para un script de migración y para
-- cualquier pantalla futura.
-- ---------------------------------------------------------------------------

-- Las filas existentes son de efectivo (las 7 ventas de prueba), así que la
-- restricción entra sin reescribir historia. Si mañana hubiera datos viejos sin
-- código, esto los delataría al primer intento de escritura, que es lo correcto.
alter table public.sale_payments
  add constraint sale_payments_reference_required
  check (
    method not in ('yape', 'plin', 'transfer', 'card')
    or nullif(btrim(coalesce(reference, '')), '') is not null
  );

comment on constraint sale_payments_reference_required on public.sale_payments is
  'Yape, Plin, transferencia y tarjeta no se registran sin su número de '
  'operación: sin él, un descuadre de caja no se puede rastrear hasta el '
  'movimiento real. El efectivo no lleva número porque no lo tiene.';

comment on column public.sale_payments.reference is
  'Número de operación del medio de pago. Obligatorio para yape/plin/transfer/'
  'card por la restricción sale_payments_reference_required.';

-- Buscar un cobro por su código es justo lo que se hace cuando la caja no
-- cuadra, y hasta ahora habría sido un recorrido secuencial de toda la tabla.
create index sale_payments_reference_idx on public.sale_payments (reference)
  where reference is not null;
