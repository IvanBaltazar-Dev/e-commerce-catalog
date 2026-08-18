-- 0121 · Retiro de una pareja falsa ya resoluble con la fuente oficial.
--
-- CIELO Hair Color Cream es una línea en crema con cuatro variantes CLC4–CLC7.
-- El producto interno BIG-COL-5E1B73 agrupa los tonos numerados de Bigen
-- Permanent Powder (26, 37, 45, 46, 47, 48, 57, 58, 59, 76 y 96). La señal
-- antigua obtuvo 0 % y no debe seguir trasladándose a la propietaria.

begin;

update public.products
set description = 'Familia Bigen Permanent Powder Hair Color, coloración permanente en polvo organizada por tonos.',
    updated_at = now()
where code = 'BIG-COL-5E1B73'
  and public.search_normalize(description) = public.search_normalize('BIGEN #26');

with false_pair as (
  select reconciliation.id
  from public.catalog_reconciliation_cases reconciliation
  where reconciliation.algorithm = 'official_product_name_and_code_v1'
    and reconciliation.score = 0
    and reconciliation.evidence ->> 'official_url'
      = 'https://www.bigen-usa.com/products/cielo-hair-color-cream'
    and reconciliation.product_id = (
      select product.id from public.products product where product.code = 'BIG-COL-5E1B73'
    )
), retired_work as (
  update public.catalog_review_work_items work
  set status = 'superseded',
      resolution_code = 'official_source_verified_false_pair',
      resolution_payload = jsonb_build_object(
        'reason', 'CIELO Hair Color Cream y Bigen Permanent Powder son líneas oficiales distintas.',
        'officialCieloUrl', 'https://www.bigen-usa.com/products/cielo-hair-color-cream',
        'officialPowderUrl', 'https://www.bigen-usa.com/products/permanent-powder',
        'commercialEffects', 0
      ),
      resolved_at = now(),
      updated_at = now()
  where work.source_type = 'reconciliation_case'
    and work.source_id in (select id from false_pair)
    and work.status in ('open', 'in_progress')
  returning work.id
)
update public.catalog_reconciliation_cases reconciliation
set status = 'superseded',
    decision_reason = 'La fuente oficial confirma que CIELO Cream y Permanent Powder son familias diferentes.',
    decided_at = coalesce(reconciliation.decided_at, now()),
    evidence = reconciliation.evidence || jsonb_build_object(
      'verifiedFalsePair', true,
      'verifiedAgainst', jsonb_build_array(
        'https://www.bigen-usa.com/products/cielo-hair-color-cream',
        'https://www.bigen-usa.com/products/permanent-powder'
      ),
      'verificationEffect', 'pair_retired_without_commercial_changes'
    ),
    updated_at = now()
where reconciliation.id in (select id from false_pair);

commit;
