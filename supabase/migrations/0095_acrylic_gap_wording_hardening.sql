-- ---------------------------------------------------------------------------
-- 0095 · Redacción no inferencial de la brecha Masglo
-- ---------------------------------------------------------------------------

begin;

update public.catalog_knowledge_gaps
set
  resolution_requirement = 'Confirmar inventario y envase. La corona de vidrio es un recipiente; no asumir que Ultrabond sea monómero ni adherente sin ficha de función.',
  metadata = jsonb_set(
    metadata,
    '{do_not_infer_ultrabond_role}',
    'true'::jsonb,
    true
  )
where gap_key = 'MASGLO_MONOMER_CATALOG_COVERAGE';

commit;
