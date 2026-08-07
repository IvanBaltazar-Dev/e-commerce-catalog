-- ---------------------------------------------------------------------------
-- 0043 — Lecturas de inteligencia comercial (Bloque 4)
--
-- Un solo contrato de lectura, `business_dashboard`, que responde las preguntas
-- económicas del plan (¿cuánto vendí, cuánto gané, cuánto gasté, qué se vende
-- más, qué canal funciona, qué proveedor conviene?) SIN crear una segunda
-- fuente de verdad: todo importe sale de las tablas del Bloque 2 y toda
-- atribución de las del Bloque 3.
--
-- Decisiones que gobiernan esta migración:
--
--   · Regla 16 del plan: nada se llama «utilidad neta» si no incluye los
--     gastos registrados. `utilidadNetaEstimada` = margen bruto − TODOS los
--     gastos vigentes del rango. Y hereda la doctrina de `sale_margins`: si
--     alguna venta del rango tiene costo desconocido, el margen bruto es NULL
--     y la utilidad también — un margen no calculable no es un margen del
--     100 %. `margenBrutoValorizado` (solo ventas con costo completo) queda
--     expuesto aparte para que el tablero nunca se quede a ciegas.
--     Se llama «estimada» incluso calculable: el costo es el capturado al
--     confirmar y los gastos son los registrados, no una contabilidad formal.
--
--   · Las devoluciones y anulaciones NO se netean en silencio de las ventas:
--     son indicadores propios. Netearlas escondería exactamente lo que la
--     dueña necesita ver crecer o decrecer.
--
--   · La deuda con proveedores es GLOBAL: las obligaciones no tienen sede,
--     así que `p_branch_id` no la filtra. Ignorar el filtro es más honesto
--     que fingir una deuda por sede que el modelo no registra.
--
--   · «Proveedor más conveniente»: el valor recibido respeta el rango, pero
--     la comparación de costos usa TODA la historia de recepciones
--     confirmadas — el conocimiento de a cuánto vende cada proveedor no
--     caduca con el filtro de fechas. Solo compiten variantes recibidas de
--     dos o más proveedores; sin comparable no hay veredicto.
--
--   · La campaña se atribuye por first-touch (`first_campaign_id` con
--     fallback al last), EXACTAMENTE como `omnichannel_metrics` en 0040:
--     dos reportes administrativos no pueden contarse historias distintas.
--
--   · Sin tablas nuevas ni índices nuevos: los compuestos existentes
--     (sales(branch,issued), expenses(branch,incurred), returns(branch,
--     occurred), receipts por proveedor) cubren estas lecturas al volumen
--     real del negocio.
-- ---------------------------------------------------------------------------

create or replace function public.business_dashboard(
  p_from date default current_date - 29,
  p_to date default current_date,
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  window_start timestamptz := p_from::timestamptz;
  window_end timestamptz := (p_to + 1)::timestamptz;
  result jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501',
      message = 'El tablero comercial es administrativo.';
  end if;

  if p_from > p_to then
    raise exception using errcode = '22023',
      message = 'El rango es inválido: la fecha inicial es posterior a la final.';
  end if;

  select jsonb_build_object(
    'rango', jsonb_build_object('desde', p_from, 'hasta', p_to, 'sedeId', p_branch_id),

    -- ------------------------------------------------------------------
    -- Ventas confirmadas del rango. Las anuladas no son venta.
    -- ------------------------------------------------------------------
    'ventas', (
      select jsonb_build_object(
        'total', coalesce(sum(s.total), 0),
        'operaciones', count(*),
        'unidades', coalesce((
          select sum(l.quantity)
          from public.sale_lines l
          join public.sales s2 on s2.id = l.sale_id
          where s2.status = 'confirmed'
            and s2.issued_at >= window_start and s2.issued_at < window_end
            and (p_branch_id is null or s2.branch_id = p_branch_id)
        ), 0),
        'ticketPromedio', round(coalesce(sum(s.total), 0) / nullif(count(*), 0), 2)
      )
      from public.sales s
      where s.status = 'confirmed'
        and s.issued_at >= window_start and s.issued_at < window_end
        and (p_branch_id is null or s.branch_id = p_branch_id)
    ),

    -- ------------------------------------------------------------------
    -- Margen y utilidad. Hereda la semántica de sale_margins: NULL cuando
    -- el costo es desconocido, jamás un cero que fabrique un 100 %.
    -- ------------------------------------------------------------------
    'margen', (
      with margenes as (
        select m.revenue, m.margin
        from public.sale_margins m
        where m.issued_at >= window_start and m.issued_at < window_end
          and (p_branch_id is null or m.branch_id = p_branch_id)
      ),
      gastos as (
        select
          coalesce(sum(e.amount), 0) as total,
          count(*) as registrados
        from public.expenses e
        where e.voided_at is null
          and e.incurred_at >= p_from and e.incurred_at <= p_to
          and (p_branch_id is null or e.branch_id = p_branch_id)
      ),
      imputados as (
        -- Gastos imputados a ventas DEL RANGO: siguen a la venta, no a la
        -- fecha del gasto, para que la contribución compare peras con peras.
        select coalesce(sum(a.amount), 0) as total
        from public.expense_allocations a
        join public.expenses e on e.id = a.expense_id and e.voided_at is null
        join public.sales s on s.id = a.sale_id
        where a.sale_id is not null
          and s.status = 'confirmed'
          and s.issued_at >= window_start and s.issued_at < window_end
          and (p_branch_id is null or s.branch_id = p_branch_id)
      )
      select jsonb_build_object(
        'ingresos', coalesce((select sum(revenue) from margenes), 0),
        'ventasValorizadas', (select count(*) from margenes where margin is not null),
        'ventasSinCosto', (select count(*) from margenes where margin is null),
        'margenBrutoValorizado', coalesce((select sum(margin) from margenes where margin is not null), 0),
        'margenBruto', case
          when exists (select 1 from margenes where margin is null) then null
          else coalesce((select sum(margin) from margenes), 0)
        end,
        'margenContribucion', case
          when exists (select 1 from margenes where margin is null) then null
          else coalesce((select sum(margin) from margenes), 0) - (select total from imputados)
        end,
        'gastosImputadosAVentas', (select total from imputados),
        'gastosTotales', (select total from gastos),
        'gastosRegistrados', (select registrados from gastos),
        'utilidadNetaEstimada', case
          when exists (select 1 from margenes where margin is null) then null
          else coalesce((select sum(margin) from margenes), 0) - (select total from gastos)
        end,
        'razonNoCalculable', case
          when exists (select 1 from margenes where margin is null) then 'ventas_sin_costo'
          else null
        end
      )
    ),

    -- ------------------------------------------------------------------
    -- Salidas de valor del rango, cada una con nombre propio.
    -- ------------------------------------------------------------------
    'devoluciones', (
      select jsonb_build_object(
        'operaciones', count(*),
        'total', coalesce(sum(r.refund_total), 0)
      )
      from public.returns r
      where r.occurred_at >= window_start and r.occurred_at < window_end
        and (p_branch_id is null or r.branch_id = p_branch_id)
    ),

    'anulaciones', (
      select jsonb_build_object(
        'operaciones', count(*),
        'total', coalesce(sum(s.total), 0)
      )
      from public.sale_cancellations c
      join public.sales s on s.id = c.sale_id
      where c.occurred_at >= window_start and c.occurred_at < window_end
        and (p_branch_id is null or c.branch_id = p_branch_id)
    ),

    'reservas', (
      select jsonb_build_object(
        'activas', count(*) filter (where r.status = 'active'),
        'activasTotal', coalesce(sum(r.total) filter (where r.status = 'active'), 0),
        'vencidas', count(*) filter (where r.status = 'expired'),
        'creadasEnRango', count(*) filter (
          where r.created_at >= window_start and r.created_at < window_end
        ),
        'convertidasEnRango', (
          select count(*)
          from public.sales s
          where s.reservation_id is not null
            and s.status = 'confirmed'
            and s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
        )
      )
      from public.reservations r
      where (p_branch_id is null or r.branch_id = p_branch_id)
    ),

    -- ------------------------------------------------------------------
    -- Deuda con proveedores, por moneda. Global a propósito: las
    -- obligaciones no tienen sede y fingir una partición sería inventar.
    -- ------------------------------------------------------------------
    'deudaProveedores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'moneda', d.currency,
        'total', d.total,
        'vencida', d.vencida,
        'obligaciones', d.obligaciones
      ) order by d.total desc)
      from (
        select
          o.currency,
          sum(o.pendiente) as total,
          sum(o.pendiente) filter (where o.due_date is not null and o.due_date < current_date) as vencida,
          count(*) as obligaciones
        from (
          select
            ob.id, ob.currency, ob.due_date,
            ob.amount_due - coalesce((
              select sum(a.amount)
              from public.supplier_payment_allocations a
              where a.supplier_obligation_id = ob.id
            ), 0) as pendiente
          from public.supplier_obligations ob
          where ob.voided_at is null
        ) o
        where o.pendiente > 0.005
        group by o.currency
      ) d
    ), '[]'::jsonb),

    'comprasPendientes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'moneda', p.currency,
        'ordenes', p.ordenes,
        'total', p.total
      ) order by p.total desc)
      from (
        select po.currency, count(*) as ordenes, sum(po.total) as total
        from public.purchase_orders po
        where po.status in ('sent', 'partially_received')
          and po.cancelled_at is null
          and (p_branch_id is null or po.branch_id = p_branch_id)
        group by po.currency
      ) p
    ), '[]'::jsonb),

    -- ------------------------------------------------------------------
    -- Rankings. El dinero sale de sale_lines; el margen solo de las líneas
    -- con costo conocido, y el porcentaje sobre SU ingreso, no el global.
    -- ------------------------------------------------------------------
    'rankings', jsonb_build_object(

      'productosPorUnidades', coalesce((
        select jsonb_agg(jsonb_build_object(
          'productoId', t.id, 'nombre', t.name, 'marca', t.brand,
          'unidades', t.units, 'ingreso', t.revenue
        ) order by t.units desc, t.revenue desc)
        from (
          select p.id, p.name, b.name as brand,
                 sum(l.quantity) as units, sum(l.subtotal) as revenue
          from public.sale_lines l
          join public.sales s on s.id = l.sale_id and s.status = 'confirmed'
          join public.product_variants v on v.id = l.variant_id
          join public.products p on p.id = v.product_id
          join public.brands b on b.id = p.brand_id
          where s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
          group by p.id, p.name, b.name
          order by units desc, revenue desc
          limit 10
        ) t
      ), '[]'::jsonb),

      'productosPorIngreso', coalesce((
        select jsonb_agg(jsonb_build_object(
          'productoId', t.id, 'nombre', t.name, 'marca', t.brand,
          'unidades', t.units, 'ingreso', t.revenue
        ) order by t.revenue desc, t.units desc)
        from (
          select p.id, p.name, b.name as brand,
                 sum(l.quantity) as units, sum(l.subtotal) as revenue
          from public.sale_lines l
          join public.sales s on s.id = l.sale_id and s.status = 'confirmed'
          join public.product_variants v on v.id = l.variant_id
          join public.products p on p.id = v.product_id
          join public.brands b on b.id = p.brand_id
          where s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
          group by p.id, p.name, b.name
          order by revenue desc, units desc
          limit 10
        ) t
      ), '[]'::jsonb),

      -- El «tono» es el de la biblioteca de colores cuando existe; si la
      -- variante no está ligada a un shade, su propio nombre es el tono.
      'tonosPorUnidades', coalesce((
        select jsonb_agg(jsonb_build_object(
          'varianteId', t.id, 'sku', t.sku, 'producto', t.product_name,
          'tono', t.tone, 'unidades', t.units, 'ingreso', t.revenue
        ) order by t.units desc, t.revenue desc)
        from (
          select v.id, v.sku, p.name as product_name,
                 coalesce(cs.name, v.name) as tone,
                 sum(l.quantity) as units, sum(l.subtotal) as revenue
          from public.sale_lines l
          join public.sales s on s.id = l.sale_id and s.status = 'confirmed'
          join public.product_variants v on v.id = l.variant_id
          join public.products p on p.id = v.product_id
          left join public.color_shades cs on cs.id = v.color_shade_id
          where s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
          group by v.id, v.sku, p.name, cs.name, v.name
          order by units desc, revenue desc
          limit 10
        ) t
      ), '[]'::jsonb),

      'productosPorMargen', coalesce((
        select jsonb_agg(jsonb_build_object(
          'productoId', t.id, 'nombre', t.name,
          'margen', t.margin, 'ingresoValorizado', t.revenue,
          'margenPorcentaje', round(100 * t.margin / nullif(t.revenue, 0), 1)
        ) order by t.margin desc)
        from (
          select p.id, p.name,
                 sum(l.subtotal - c.total_cost) as margin,
                 sum(l.subtotal) as revenue
          from public.sale_lines l
          join public.sales s on s.id = l.sale_id and s.status = 'confirmed'
          join public.sale_line_costs c on c.sale_line_id = l.id
            and c.cost_basis <> 'unknown'
          join public.product_variants v on v.id = l.variant_id
          join public.products p on p.id = v.product_id
          where s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
          group by p.id, p.name
          order by margin desc
          limit 10
        ) t
      ), '[]'::jsonb),

      'categorias', coalesce((
        select jsonb_agg(jsonb_build_object(
          'categoriaId', t.id, 'nombre', t.name,
          'ingreso', t.revenue, 'margen', t.margin
        ) order by t.revenue desc)
        from (
          select cat.id, cat.name,
                 sum(l.subtotal) as revenue,
                 sum(l.subtotal - c.total_cost) filter (where c.cost_basis <> 'unknown') as margin
          from public.sale_lines l
          join public.sales s on s.id = l.sale_id and s.status = 'confirmed'
          join public.sale_line_costs c on c.sale_line_id = l.id
          join public.product_variants v on v.id = l.variant_id
          join public.products p on p.id = v.product_id
          join public.categories cat on cat.id = p.category_id
          where s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
          group by cat.id, cat.name
          order by revenue desc
          limit 10
        ) t
      ), '[]'::jsonb),

      'marcas', coalesce((
        select jsonb_agg(jsonb_build_object(
          'marcaId', t.id, 'nombre', t.name,
          'ingreso', t.revenue, 'margen', t.margin
        ) order by t.revenue desc)
        from (
          select b.id, b.name,
                 sum(l.subtotal) as revenue,
                 sum(l.subtotal - c.total_cost) filter (where c.cost_basis <> 'unknown') as margin
          from public.sale_lines l
          join public.sales s on s.id = l.sale_id and s.status = 'confirmed'
          join public.sale_line_costs c on c.sale_line_id = l.id
          join public.product_variants v on v.id = l.variant_id
          join public.products p on p.id = v.product_id
          join public.brands b on b.id = p.brand_id
          where s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
          group by b.id, b.name
          order by revenue desc
          limit 10
        ) t
      ), '[]'::jsonb),

      -- El canal de ORIGEN de la venta, el dato que el Bloque 3 conserva
      -- desde la conversión. Mismo formato objeto que omnichannel_metrics.
      'canales', coalesce((
        select jsonb_object_agg(t.source_channel, jsonb_build_object(
          'operaciones', t.total_count,
          'ingreso', t.revenue,
          'ticketPromedio', round(t.revenue / nullif(t.total_count, 0), 2)
        ))
        from (
          select s.source_channel, count(*) as total_count, sum(s.total) as revenue
          from public.sales s
          where s.status = 'confirmed'
            and s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
          group by s.source_channel
        ) t
      ), '{}'::jsonb),

      -- Campaña por first-touch, con el MISMO coalesce que 0040.
      'campanas', coalesce((
        select jsonb_agg(jsonb_build_object(
          'campana', t.code, 'nombre', t.name,
          'ventas', t.total_count, 'ingreso', t.revenue
        ) order by t.revenue desc)
        from (
          select mc.code, mc.name, count(*) as total_count, sum(s.total) as revenue
          from public.channel_attributions a
          join public.sales s on s.id = a.sale_id and s.status = 'confirmed'
          join public.marketing_campaigns mc
            on mc.id = coalesce(a.first_campaign_id, a.last_campaign_id)
          where s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
          group by mc.code, mc.name
          order by revenue desc
          limit 10
        ) t
      ), '[]'::jsonb),

      'vendedoras', coalesce((
        select jsonb_agg(jsonb_build_object(
          'vendedoraId', t.seller_id,
          'etiqueta', t.seller_label,
          'operaciones', t.total_count,
          'ingreso', t.revenue
        ) order by t.revenue desc)
        from (
          select s.seller_id, coalesce(s.seller_label, 'Sin registrar') as seller_label,
                 count(*) as total_count, sum(s.total) as revenue
          from public.sales s
          where s.status = 'confirmed'
            and s.issued_at >= window_start and s.issued_at < window_end
            and (p_branch_id is null or s.branch_id = p_branch_id)
          group by s.seller_id, coalesce(s.seller_label, 'Sin registrar')
          order by revenue desc
          limit 10
        ) t
      ), '[]'::jsonb),

      -- Valor recibido en el rango + veredicto de conveniencia sobre toda
      -- la historia: gana quien es más barato en más variantes comparables.
      'proveedores', coalesce((
        select jsonb_agg(jsonb_build_object(
          'proveedorId', t.id,
          'nombre', t.trade_name,
          'recibidoPen', t.recibido,
          'recepciones', t.recepciones,
          'variantesComparables', t.comparables,
          'masBaratoEn', t.wins
        ) order by t.wins desc, t.recibido desc)
        from (
          with costos as (
            select r.supplier_id, l.variant_id, avg(l.unit_cost_pen) as costo
            from public.goods_receipt_lines l
            join public.goods_receipts r on r.id = l.goods_receipt_id
              and r.status = 'confirmed'
            where l.unit_cost_pen > 0 and l.received_units > 0
            group by r.supplier_id, l.variant_id
          ),
          comparables as (
            select variant_id from costos group by variant_id having count(*) >= 2
          ),
          ganadores as (
            select distinct on (c.variant_id) c.variant_id, c.supplier_id
            from costos c
            join comparables cm on cm.variant_id = c.variant_id
            order by c.variant_id, c.costo asc, c.supplier_id
          ),
          recibido as (
            select r.supplier_id,
                   sum(r.goods_total_pen) as total,
                   count(*) as recepciones
            from public.goods_receipts r
            where r.status = 'confirmed'
              and r.received_at >= window_start and r.received_at < window_end
              and (p_branch_id is null or r.branch_id = p_branch_id)
            group by r.supplier_id
          )
          select sp.id, sp.trade_name,
                 coalesce(rc.total, 0) as recibido,
                 coalesce(rc.recepciones, 0) as recepciones,
                 coalesce((
                   select count(*) from costos c2
                   join comparables cm2 on cm2.variant_id = c2.variant_id
                   where c2.supplier_id = sp.id
                 ), 0) as comparables,
                 coalesce(g.wins, 0) as wins
          from public.suppliers sp
          left join recibido rc on rc.supplier_id = sp.id
          left join (
            select supplier_id, count(*) as wins
            from ganadores group by supplier_id
          ) g on g.supplier_id = sp.id
          where rc.supplier_id is not null or coalesce(g.wins, 0) > 0
          order by wins desc, recibido desc
          limit 10
        ) t
      ), '[]'::jsonb)
    )
  ) into result;

  return result;
end;
$$;

comment on function public.business_dashboard(date, date, uuid) is
  'Tablero comercial administrativo. Indicadores y rankings del rango sobre '
  'las tablas del Bloque 2/3, sin duplicar ninguna fuente de verdad. La '
  'utilidad neta estimada respeta la regla 16: incluye los gastos registrados '
  'y es NULL —no cero— cuando alguna venta del rango tiene costo desconocido.';

-- La doctrina del ACL: nada ejecutable por defecto, el gate vive dentro.
revoke all on function public.business_dashboard(date, date, uuid) from public, anon;
grant execute on function public.business_dashboard(date, date, uuid) to authenticated, service_role;
