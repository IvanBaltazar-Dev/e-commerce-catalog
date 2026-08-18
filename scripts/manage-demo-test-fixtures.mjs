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
  psql(`
begin;
insert into public.inventory_stock (variant_id, branch_id, on_hand)
select variant.id, branch.id, 100
from public.product_variants variant
join public.products product on product.id = variant.product_id
left join public.brands brand on brand.id = product.brand_id
cross join lateral (
  select id from public.branches where is_default limit 1
) as branch
where product.code like 'DEMO-%' or product.slug like 'demo-%' or brand.slug = 'demo-professional'
on conflict (variant_id, branch_id) do update
  set on_hand = greatest(public.inventory_stock.on_hand, excluded.on_hand),
      updated_at = now();
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
