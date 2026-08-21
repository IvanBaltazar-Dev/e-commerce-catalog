-- Ninguna derivación retirada puede aparecer en una lectura activa.
--
-- No es teórico: al marcar las 1.395 variantes falsas de Cherimoya, el grafo
-- siguió sirviéndolas porque leía la tabla base. Marcar y circular a la vez es
-- peor que no marcar, porque parece resuelto.
select
  (select count(*) from graph_nodes_v2_base g
     where g.entity_id in (select id from catalog_reference_variants where superseded_at is not null))
  as variantes_retiradas_en_grafo,
  (select count(*) from graph_nodes_v2_base g
     where g.entity_id in (select id from catalog_reference_prices where superseded_at is not null))
  as precios_retirados_en_grafo,
  (select count(*) from catalog_reference_variants_vigentes_v1 where superseded_at is not null)
  as retirados_en_vista_vigentes,
  (select count(*) from catalog_reference_variants where superseded_at is not null)
  as retirados_conservados_como_historia;
