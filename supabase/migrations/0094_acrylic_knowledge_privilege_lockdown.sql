-- ---------------------------------------------------------------------------
-- 0094 · Cierre de privilegios del vertical Acrílico
-- ---------------------------------------------------------------------------

begin;

-- Es una función de trigger, no una RPC. El trigger puede seguir ejecutándola,
-- pero ningún cliente debe invocarla directamente.
revoke execute on function public.validate_catalog_knowledge_gap_resolution()
from public, anon, authenticated;

commit;
