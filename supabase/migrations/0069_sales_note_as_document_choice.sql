-- ---------------------------------------------------------------------------
-- 0069 · «Nota de venta» es una de las tres opciones, no la ausencia de opción
-- ---------------------------------------------------------------------------
-- 0068 dejó a elegir entre boleta y factura, y eso es la pregunta a medias. En
-- el mostrador la pregunta real es «¿qué documento lleva?» y tiene TRES
-- respuestas: nota de venta, boleta o factura. La nota es la respuesta más
-- frecuente con diferencia, y sin embargo era la única que no se podía elegir:
-- se obtenía no eligiendo nada.
--
-- POR QUÉ IMPORTA QUE SE PUEDA ELEGIR:
--
--   · Quien vende tiene que poder cerrar la pregunta. «No pedí comprobante» y
--     «la clienta dijo que solo quería su nota» se ven igual en la pantalla y no
--     son lo mismo cuando alguien reclama tres días después.
--   · Se puede CORREGIR. Si se pidió boleta por error, hoy no había manera de
--     volver atrás: solo se podía cambiar por factura.
--   · Se puede contar. Cuántas ventas piden comprobante es una pregunta de
--     negocio que hasta ahora no tenía respuesta, porque «sin fila» mezclaba a
--     quien no lo quiso con a quien no se le preguntó.
--
-- LO QUE NO CAMBIA: la nota de venta NO es un comprobante autorizado, y el
-- ticket lo sigue diciendo en su recuadro. Elegirla aquí es registrar que la
-- clienta no pidió comprobante fiscal, no emitirle uno.
-- ---------------------------------------------------------------------------

alter table public.tax_document_requests
  drop constraint tax_document_requests_kind_allowed;

alter table public.tax_document_requests
  add constraint tax_document_requests_kind_allowed
  check (kind in ('invoice', 'sales_receipt', 'sales_note'));

comment on constraint tax_document_requests_kind_allowed on public.tax_document_requests is
  'Las tres respuestas a «¿qué documento lleva?». `sales_note` no es un '
  'comprobante fiscal: registra que la clienta no pidió ninguno, que es un dato '
  'distinto de no haberle preguntado.';

-- La nota no exige nada: es el documento interno que la venta ya lleva.
insert into public.tax_document_requirements
  (kind, tax_id_label, tax_id_pattern, tax_id_required_from, requires_name, requires_address, hint) values
  ('sales_note', 'Documento', '^[0-9]{8,11}$', null, false, false,
   'La nota de venta es el documento interno de la compra. No es comprobante autorizado.')
on conflict (kind) do nothing;

-- El orden en que se ofrecen. La nota primero porque es la respuesta normal, y
-- ponerla al final invita a elegir comprobante por descarte.
alter table public.tax_document_requirements
  add column sort_order smallint not null default 50;

update public.tax_document_requirements set sort_order = 10 where kind = 'sales_note';
update public.tax_document_requirements set sort_order = 20 where kind = 'sales_receipt';
update public.tax_document_requirements set sort_order = 30 where kind = 'invoice';

comment on column public.tax_document_requirements.sort_order is
  'En qué orden se ofrecen. La nota de venta va primero: es la respuesta normal, '
  'y dejarla al final hace que se elija comprobante por descarte.';
