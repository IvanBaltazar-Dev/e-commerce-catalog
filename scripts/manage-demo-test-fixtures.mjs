/** Carga o retira los productos DEMO exclusivamente alrededor de pruebas. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_e-commerce-catalog";
const mode = process.argv.includes("--load") ? "load" : process.argv.includes("--cleanup") ? "cleanup" : null;
if (!mode) throw new Error("Usa --load o --cleanup.");

function psql(sql) {
  const result = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { cwd: ROOT, input: sql, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

if (mode === "load") {
  const seed = fs.readFileSync(path.join(ROOT, "supabase", "seeds", "0002_v2_demo.sql"), "utf8");
  psql(`begin;\n${seed}\ncommit;`);

  // Mientras los artículos DEMO vivían dentro del checkpoint, su inventario
  // venía con ellos. Al aislarlos como fixture, el seed dejó de traerlo: los
  // productos nacían sin existencias en la sede por defecto y la integral
  // omnicanal moría al convertir el carrito en reserva —el carrito público usa
  // esa sede, no las que las integrales crean para sí—. El fixture tiene que
  // reponer lo que el checkpoint daba, o no es el mismo punto de partida.
  // El inventario entra por el motor, nunca por un insert directo: cada unidad
  // deja su asiento en el kardex y su valoración. Una fila de existencias sin
  // movimiento que la explique rompe el invariante que 0028 comprueba fila a
  // fila —el saldo del kardex tiene que coincidir con inventory_stock siempre—.
  psql(`
begin;
do $fixture_stock$
declare
  default_branch uuid;
  fixture_variant uuid;
begin
  select id into default_branch from public.branches where is_default limit 1;
  if default_branch is null then
    raise exception 'No hay sede por defecto donde reponer los fixtures DEMO.';
  end if;

  -- Solo las dos variantes que las integrales consumen. Las demás tienen que
  -- seguir sin existencias: 0028 las eligió justamente porque ningún seed las
  -- toca, y la disponibilidad efectiva agrega sobre todas las sedes, así que
  -- una unidad sembrada aquí haría que nunca salgan agotadas.
  for fixture_variant in
    select variant.id
    from public.product_variants variant
    where variant.sku in ('DEMO-ESM-ROJO', 'DEMO-ESM-NUDE')
  loop
    if coalesce((
      select stock.on_hand from public.inventory_stock stock
      where stock.variant_id = fixture_variant and stock.branch_id = default_branch
    ), 0) < 100 then
      perform public.apply_inventory_movement(
        fixture_variant, default_branch, 'receipt', 100, 10.00,
        'test_fixture', null, 'seed:test-catalog',
        'Existencias de fixture DEMO para las pruebas integrales', null
      );
    end if;
  end loop;
end;
$fixture_stock$;
commit;
`);
  console.log("Fixtures DEMO cargados temporalmente para pruebas, con existencias en la sede por defecto.");
} else {
  psql(`
begin;
create temporary table test_demo_products on commit drop as
select product.id
from public.products product
left join public.brands brand on brand.id=product.brand_id
where product.code like 'DEMO-%' or product.slug like 'demo-%' or brand.slug='demo-professional';

create temporary table test_demo_variants on commit drop as
select variant.id from public.product_variants variant
where variant.product_id in (select id from test_demo_products);

create temporary table test_demo_candidates on commit drop as
select candidate.id from public.catalog_relation_candidates candidate
where candidate.source_product_id in (select id from test_demo_products)
   or candidate.target_product_id in (select id from test_demo_products);

do $fixture_cleanup$
declare protected_rows integer;
begin
  select
      (select count(*) from public.sale_lines where variant_id in (select id from test_demo_variants))
    + (select count(*) from public.return_lines where variant_id in (select id from test_demo_variants))
    + (select count(*) from public.goods_receipt_lines where variant_id in (select id from test_demo_variants))
    + (select count(*) from public.purchase_order_lines where variant_id in (select id from test_demo_variants))
    + (select count(*) from public.reservation_lines where variant_id in (select id from test_demo_variants))
    + (select count(*) from public.inventory_transfer_lines where variant_id in (select id from test_demo_variants))
    + (select count(*) from public.public_cart_items where variant_id in (select id from test_demo_variants))
    + (select count(*) from public.catalog_relation_reprocess_items where candidate_id in (select id from test_demo_candidates))
    + (select count(*) from public.catalog_relation_decision_items where candidate_id in (select id from test_demo_candidates))
  into protected_rows;

  if protected_rows > 0 then
    raise exception using errcode='23503',
      message='Los fixtures DEMO tienen referencias persistentes; la prueba debe limpiar sus operaciones antes de retirarlos.';
  end if;
end;
$fixture_cleanup$;

delete from public.catalog_review_work_items work
where work.source_type='relation_candidate'
  and work.source_id in (select id from test_demo_candidates)
  and not exists (select 1 from public.catalog_review_batch_items item where item.work_item_id=work.id)
  and not exists (select 1 from public.catalog_review_reprocess_items item where item.work_item_id=work.id)
  and not exists (select 1 from public.catalog_canonical_promotions promotion where promotion.review_work_item_id=work.id);

update public.catalog_review_work_items work
set status='superseded', resolution_code='test_fixture_removed',
    resolution_payload=jsonb_build_object('reason','Fixture DEMO temporal retirado.'),
    resolved_at=now(), updated_at=now()
where work.source_type='relation_candidate'
  and work.source_id in (select id from test_demo_candidates)
  and work.status in ('open','in_progress');

delete from public.catalog_relation_candidates where id in (select id from test_demo_candidates);
delete from public.inventory_valuation where variant_id in (select id from test_demo_variants);
delete from public.inventory_stock where variant_id in (select id from test_demo_variants);
delete from public.inventory_movements where variant_id in (select id from test_demo_variants);
delete from public.initial_load_rows where variant_id in (select id from test_demo_variants);
delete from public.wholesale_rules
where product_id in (select id from test_demo_products) or variant_id in (select id from test_demo_variants);
delete from public.product_relations
where source_product_id in (select id from test_demo_products) or target_product_id in (select id from test_demo_products);
delete from public.products where id in (select id from test_demo_products);
delete from public.media_assets media
where (media.storage_path like 'demo/%' or media.metadata->>'demo'='true')
  and not exists (select 1 from public.product_media association where association.media_asset_id=media.id)
  and not exists (select 1 from public.brands brand where brand.logo_media_id=media.id);
delete from public.brands brand where brand.slug='demo-professional'
  and not exists (select 1 from public.products product where product.brand_id=brand.id);
commit;
  `);
  console.log("Fixtures DEMO retirados; el catálogo operativo vuelve a quedar limpio.");
}
