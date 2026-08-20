-- 0142 · Clases de fuente que la investigación de REVEL hizo necesarias.
--
-- «authorized_distributor» era demasiado conservador para el catálogo Sumerlabs
-- de REVEL: no lo publica un tercero que revende, lo publica quien opera la
-- marca en Perú. Y «marketplace» no describe un registro aduanero, que es la
-- fuente más fuerte que tenemos para importador, exportador, origen y NSOC.
--
--   first_party_commercial  canal propio del operador de la marca. Manda sobre
--                           código, nombre comercial, precio y disponibilidad.
--                           NO sobre fabricante ni composición.
--   trade_record            comercio exterior. Manda sobre importador,
--                           exportador, país, fecha, presentación declarada y
--                           registro sanitario. No sobre beneficios comerciales.
--   regulatory_or_label     rotulado y documentación sanitaria. Manda sobre
--                           ingredientes, advertencias y fabricante.
--
-- Ninguna es «la fuente buena»: la autoridad ya es por predicado en
-- catalog_source_predicate_authority, y estas clases son su eje de entrada.
alter table public.catalog_sources drop constraint if exists catalog_sources_authority_allowed;
alter table public.catalog_sources add constraint catalog_sources_authority_allowed
  check (authority = any (array[
    'official','authorized_distributor','marketplace','internal_document','physical_packaging',
    'first_party_commercial','trade_record','regulatory_or_label'
  ]));

-- El catálogo de Sumerlabs no es Shopify ni Woo: es una SPA que sirve su
-- catálogo como JSON embebido en el HTML. Merece adaptador propio porque su
-- forma de paginar y de exponer el código dentro de la descripción no se parece
-- a las otras.
alter table public.catalog_sources drop constraint if exists catalog_sources_adapter_allowed;
alter table public.catalog_sources add constraint catalog_sources_adapter_allowed
  check (adapter = any (array[
    'shopify_products_json','woocommerce_store_api','html','pdf','spreadsheet','manual_capture',
    'sumer_ssr_json'
  ]));
