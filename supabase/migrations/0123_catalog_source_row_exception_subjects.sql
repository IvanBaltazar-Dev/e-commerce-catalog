-- 0123 · Cada fila fuente recupera el producto que creó.
--
-- Las 107 excepciones de identidad de fila fuente llegaron a la base sin
-- producto ni variante: solo con el texto "SOURCE_ROW: PEINE CARBON WAHL
-- NEGRO" y una clave "Excel:109" que no existe en ninguna tabla. La Mesa
-- preguntaba por algo que la propietaria no podía abrir.
--
-- El enlace nunca se perdió: está en research/catalog-master/data/
-- source_row_reconciliation.csv, en las columnas internal_product_id e
-- internal_variant_id, en la misma fila que produjo la excepción. El
-- generador se quedó con entity_key y descartó el destino que él mismo
-- había calculado.
--
-- Aquí vuelve. Las 107 preguntas pasan a tener sujeto verificable y la
-- compuerta de 0122 deja de tratarlas como referencias colgadas: dejaron de
-- serlo. La comparación deja de adivinar por parecido de nombre cuando existe
-- un enlace exacto.
--
-- No se crea, publica ni modifica ningún producto: solo se restituye a qué
-- apunta cada pregunta.
--
-- La corrección duradera está en el cargador, no aquí: desde ahora
-- `scripts/catalog-enrichment-stage.mjs` escribe el producto y la variante al
-- crear la excepción. Esta migración repara las bases que ya se cargaron con el
-- contrato antiguo. Sobre una base reconstruida desde cero no encuentra nada que
-- reparar —los productos aún no existen cuando corren las migraciones— y
-- termina sin tocar ninguna fila. Es lo esperado, no un fallo silencioso.

begin;

create temp table catalog_source_row_links(
  source_key text primary key,
  product_id uuid not null,
  variant_id uuid
);

insert into catalog_source_row_links(source_key, product_id, variant_id) values
  ('Excel:46', '104f4b97-b0f5-4dcb-afa0-886a34443d2e'::uuid, '52304460-102d-42c1-aa8d-49550512e927'::uuid),
  ('Excel:103', '3b6c2791-3c67-4eb9-b6c0-da64a8972b51'::uuid, 'dfa7b497-fad2-4806-9050-19437212e799'::uuid),
  ('Excel:109', 'd5252c4b-c4de-4bf2-b9a1-2c74e4db8f92'::uuid, 'ec7ee574-5f44-42f6-b930-6e110e1ec12d'::uuid),
  ('Excel:229', 'd8565d55-d6cd-4796-96d9-f438638bf8cf'::uuid, 'ff5daf3b-38d8-43fd-851c-e5f7135700cc'::uuid),
  ('Excel:230', 'd8565d55-d6cd-4796-96d9-f438638bf8cf'::uuid, 'ff5daf3b-38d8-43fd-851c-e5f7135700cc'::uuid),
  ('Excel:232', '31bc87f1-3e05-4bc0-950d-853b3b6755a9'::uuid, '7284c448-0aaa-4f00-9f51-81eb70d6730e'::uuid),
  ('Excel:253', 'caea9160-22cc-4e62-bb4e-2873bd5ff7ae'::uuid, '73473008-8075-4f19-9220-02525914f281'::uuid),
  ('Excel:256', '39d75272-3467-4d4f-bdb1-d82e89c2a07b'::uuid, '0a721cbb-7a46-46a9-8118-5dd1fc3d2bff'::uuid),
  ('Excel:257', '39d75272-3467-4d4f-bdb1-d82e89c2a07b'::uuid, '0a721cbb-7a46-46a9-8118-5dd1fc3d2bff'::uuid),
  ('Excel:259', '444471a9-a2b5-424e-b26a-b135899ea900'::uuid, '1a252938-49f6-4dc2-b13b-9be33c268068'::uuid),
  ('Excel:273', '2383505f-2330-47d8-8e83-aecae34035b6'::uuid, 'db67fc06-c366-4172-acdb-a57a4f244137'::uuid),
  ('Excel:306', '4d9ef17e-fad9-406b-afac-5fc523223232'::uuid, 'bac8814c-742a-406e-94ac-b9c069b3e440'::uuid),
  ('Excel:432', '9af7162c-b08b-4db7-9fba-39d9ffce5f4f'::uuid, '9eebafed-82d0-411b-ac27-46e357309cfd'::uuid),
  ('Excel:474', '38c88729-5d78-4261-abf6-cf6dc63ef736'::uuid, '9d20403c-83f8-430b-a4bf-4e22656a59d6'::uuid),
  ('Excel:475', 'e909fcdf-fe79-4e55-8d6c-59cfe7fc8b6e'::uuid, 'f32b2349-9309-46c8-a711-aec30a0373b8'::uuid),
  ('Excel:476', '694dc290-cd28-4429-b11e-1b62afa9da5c'::uuid, '753a5544-6789-46fb-8ce5-f609d385a668'::uuid),
  ('Excel:477', '0c96c554-c131-4fbf-a6a8-faa936d58658'::uuid, '2f521a95-8227-481f-82cb-a5c6cae5606e'::uuid),
  ('Excel:478', '433b37d8-2298-46e0-9192-80e354575696'::uuid, '6d65a7ea-30cd-4e8e-9925-edb21791a8e4'::uuid),
  ('Excel:479', '173ea4c3-1c4f-4c18-8283-c95055adb6d2'::uuid, '31aa30d1-8e0e-40e1-9fe9-d3b0000eadea'::uuid),
  ('Excel:535', '0d475d0e-3d77-4af6-9458-62b603820c85'::uuid, '5dd7ae41-458f-4d87-9f02-22f219750d1b'::uuid),
  ('Excel:605', '0be4df30-3c4d-4e68-b9db-57de52b8c885'::uuid, '4d0ab86f-a1ba-4ef7-b76f-0009d197e5dd'::uuid),
  ('Excel:659', 'fcc88f26-00b8-4a7f-8f18-b3451c4fbb4b'::uuid, 'd5ab0ea6-d7e6-4ffb-8ab2-132197a67076'::uuid),
  ('Excel:746', '467cbe74-a298-4645-b66d-54addc55d83c'::uuid, '619a8d38-ac02-4c06-8a26-dcfebc7a6e46'::uuid),
  ('Excel:764', '3ff94994-6d33-48e7-9211-4f544dd378da'::uuid, '93dfaf9b-394e-4579-b74d-858bbe3c7a44'::uuid),
  ('Excel:768', '3ff94994-6d33-48e7-9211-4f544dd378da'::uuid, '063c868e-74b5-477b-83b8-f6315e595f5e'::uuid),
  ('Excel:771', '2684ad3f-4659-4668-9ee2-200b66e4658d'::uuid, '0fba8400-81c6-42fb-818a-0ba229d021d8'::uuid),
  ('Excel:1028', 'e909fcdf-fe79-4e55-8d6c-59cfe7fc8b6e'::uuid, '9c91914f-82c9-41e6-848d-035dcf6951be'::uuid),
  ('Excel:1034', 'e909fcdf-fe79-4e55-8d6c-59cfe7fc8b6e'::uuid, '7b50f290-8a1f-4d13-87ac-c7304d426217'::uuid),
  ('Excel:1086', '5ed5cde9-f923-4994-a844-bef52161ca32'::uuid, 'd35e32d2-504f-4eee-ae53-54cf09bd80e9'::uuid),
  ('Excel:1087', '5ed5cde9-f923-4994-a844-bef52161ca32'::uuid, 'd35e32d2-504f-4eee-ae53-54cf09bd80e9'::uuid),
  ('Excel:1089', '89b93fc7-c500-4912-86d2-679f793878eb'::uuid, '6fafb936-9c2b-4d34-baaf-ba747b545b00'::uuid),
  ('Excel:1091', '89b93fc7-c500-4912-86d2-679f793878eb'::uuid, '6fafb936-9c2b-4d34-baaf-ba747b545b00'::uuid),
  ('Excel:1238', 'cc729784-a6cd-43c5-b587-0783a3bfc8b3'::uuid, 'fb0591ce-2014-4e43-85e9-d53b00d4e71a'::uuid),
  ('Excel:1259', '1302e620-5f62-4b47-b416-573ed151019d'::uuid, 'e7be5c5b-167a-4c2a-8c20-cd4b9039d932'::uuid),
  ('Excel:1261', 'f20fb7bc-b80f-43cd-8e2b-ce0144184bce'::uuid, '96bbafae-911f-4674-9371-ba08ee1c5ab9'::uuid),
  ('Excel:1262', 'f20fb7bc-b80f-43cd-8e2b-ce0144184bce'::uuid, '96bbafae-911f-4674-9371-ba08ee1c5ab9'::uuid),
  ('Excel:1264', '3ee7f019-c8bb-4c67-bf57-8760767197ab'::uuid, 'c329a013-f7b5-4491-9202-9c8e22311f7f'::uuid),
  ('Excel:1286', 'b489ffcd-9da7-47b8-9500-9a228e207e85'::uuid, 'f56b510d-7ae1-4b3a-a504-8ffef86354bf'::uuid),
  ('Excel:1297', 'b4018462-91f8-4abc-8063-ebfeb0ba6520'::uuid, '93f289d1-9e0b-4e1b-95da-acd507424b56'::uuid),
  ('Excel:1299', '119de053-0bc5-486c-9977-095835629753'::uuid, '3340d4b4-2b51-467a-a691-8db0b9c6ddda'::uuid),
  ('Excel:1300', '119de053-0bc5-486c-9977-095835629753'::uuid, '3340d4b4-2b51-467a-a691-8db0b9c6ddda'::uuid),
  ('Excel:1309', 'dd39068e-5056-463b-834f-8864c9393047'::uuid, '5ba61c8d-858c-448f-b9ba-ceff9c1291bb'::uuid),
  ('Excel:1355', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1356', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1357', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1358', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1359', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1360', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1361', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1362', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1363', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1364', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1365', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1366', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1367', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1368', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1369', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1370', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1371', '60279e1d-65c9-4b8b-acdc-31f4f6591a4b'::uuid, 'e30a8473-b097-462c-8983-de53dc0fa11a'::uuid),
  ('Excel:1377', '0ec2e6a2-049e-4bd3-a9ba-2699937e0726'::uuid, 'c79ffe0a-34f5-4372-a015-fea94082eb25'::uuid),
  ('Excel:1378', '0ec2e6a2-049e-4bd3-a9ba-2699937e0726'::uuid, 'c79ffe0a-34f5-4372-a015-fea94082eb25'::uuid),
  ('Excel:1379', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1380', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1381', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1382', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1383', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1384', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1385', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1386', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1387', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1388', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1389', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1390', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1391', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1392', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1393', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1394', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1395', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1396', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1397', '251c3a16-67a9-4321-be80-30c0ba0d049e'::uuid, '3222daa0-fecc-4f6b-a777-68f21fe662d6'::uuid),
  ('Excel:1404', '2886c892-0f48-48d7-919f-8551131be783'::uuid, '0fbb147e-5708-4679-95ad-d72d1013a177'::uuid),
  ('Excel:1405', '2886c892-0f48-48d7-919f-8551131be783'::uuid, '0fbb147e-5708-4679-95ad-d72d1013a177'::uuid),
  ('Excel:1408', '8ffef33d-8017-4183-9da4-75c6b2e312e1'::uuid, '4ca3774e-6057-446f-8b7a-775d43e99793'::uuid),
  ('Excel:1409', '78d44ef9-f19f-4b15-b192-c6cee119c485'::uuid, 'e50021c0-62cf-4e72-9061-126a6d73fb84'::uuid),
  ('Excel:1410', '8ffef33d-8017-4183-9da4-75c6b2e312e1'::uuid, '4ca3774e-6057-446f-8b7a-775d43e99793'::uuid),
  ('Excel:1411', '8ffef33d-8017-4183-9da4-75c6b2e312e1'::uuid, '4ca3774e-6057-446f-8b7a-775d43e99793'::uuid),
  ('Excel:1412', '8ffef33d-8017-4183-9da4-75c6b2e312e1'::uuid, '4ca3774e-6057-446f-8b7a-775d43e99793'::uuid),
  ('Excel:1413', '8ffef33d-8017-4183-9da4-75c6b2e312e1'::uuid, '4ca3774e-6057-446f-8b7a-775d43e99793'::uuid),
  ('Excel:1422', '29c9d6e7-06ed-41e9-9331-bb08fd190491'::uuid, '245f3a53-ad0f-4fd2-a1e2-b00a26b784a2'::uuid),
  ('Excel:1423', '29c9d6e7-06ed-41e9-9331-bb08fd190491'::uuid, '245f3a53-ad0f-4fd2-a1e2-b00a26b784a2'::uuid),
  ('Excel:1424', '29c9d6e7-06ed-41e9-9331-bb08fd190491'::uuid, '245f3a53-ad0f-4fd2-a1e2-b00a26b784a2'::uuid),
  ('Excel:1425', '29c9d6e7-06ed-41e9-9331-bb08fd190491'::uuid, '245f3a53-ad0f-4fd2-a1e2-b00a26b784a2'::uuid),
  ('Excel:1426', '29c9d6e7-06ed-41e9-9331-bb08fd190491'::uuid, '245f3a53-ad0f-4fd2-a1e2-b00a26b784a2'::uuid),
  ('Excel:1427', '29c9d6e7-06ed-41e9-9331-bb08fd190491'::uuid, '245f3a53-ad0f-4fd2-a1e2-b00a26b784a2'::uuid),
  ('Excel:1428', '29c9d6e7-06ed-41e9-9331-bb08fd190491'::uuid, '245f3a53-ad0f-4fd2-a1e2-b00a26b784a2'::uuid),
  ('Excel:1431', 'd7b4ce0a-c0a2-44ce-8c14-f6456e3790f4'::uuid, '0d3219a9-8d88-4dd2-8d3c-84dccf8dd0c8'::uuid),
  ('Excel:1433', '03eb1a1c-6a8d-46d0-8580-336997cb7f14'::uuid, '7cc7641b-0e4f-4101-ac87-7e19c9fa5e71'::uuid),
  ('Excel:1434', 'd7b4ce0a-c0a2-44ce-8c14-f6456e3790f4'::uuid, '0d3219a9-8d88-4dd2-8d3c-84dccf8dd0c8'::uuid),
  ('Excel:1435', '63dfbce3-4db4-45b9-bcf2-297b6ff697ff'::uuid, '2b61fabb-619c-4676-9ebb-4ddbb79d46a0'::uuid),
  ('Excel:1436', '03eb1a1c-6a8d-46d0-8580-336997cb7f14'::uuid, '7cc7641b-0e4f-4101-ac87-7e19c9fa5e71'::uuid),
  ('Excel:1437', '29c9d6e7-06ed-41e9-9331-bb08fd190491'::uuid, '245f3a53-ad0f-4fd2-a1e2-b00a26b784a2'::uuid),
  ('Excel:1442', '4c2d196b-bd6c-4489-b0d0-04c2b954e82e'::uuid, 'b748c4d8-56a7-4600-811a-b56507ae16f7'::uuid),
  ('Excel:1443', 'ea0c5fd2-3e6e-4fc2-ac8d-c60280a41adf'::uuid, '1fd2d9d0-918b-4821-9d23-0f773a49bf08'::uuid),
  ('Excel:1444', '4c2d196b-bd6c-4489-b0d0-04c2b954e82e'::uuid, 'b748c4d8-56a7-4600-811a-b56507ae16f7'::uuid),
  ('Excel:1445', '4c2d196b-bd6c-4489-b0d0-04c2b954e82e'::uuid, 'b748c4d8-56a7-4600-811a-b56507ae16f7'::uuid),
  ('Excel:1489', '6bb3ed34-de88-43e4-9996-da4550820fbb'::uuid, '2da5c325-d279-44cc-8e35-833914d3882f'::uuid),
  ('Excel:1491', '6bb3ed34-de88-43e4-9996-da4550820fbb'::uuid, '2da5c325-d279-44cc-8e35-833914d3882f'::uuid);

-- Solo se enlaza contra productos y variantes que existan hoy. Si el catálogo
-- cambió y alguna desapareció, la excepción se queda como estaba en vez de
-- apuntar a un identificador muerto: el objetivo es lo contrario.
update public.catalog_enrichment_exceptions exception
set product_id = link.product_id,
    variant_id = variant.id,
    updated_at = now()
from catalog_source_row_links link
join public.products product on product.id = link.product_id
left join public.product_variants variant
  on variant.id = link.variant_id and variant.product_id = link.product_id
where exception.exception_type = 'identity_ambiguous'
  and exception.details ->> 'source_scope' = 'SOURCE_ROW'
  and exception.details ->> 'source_key' = link.source_key
  and exception.product_id is null;

-- Cuando la excepción ya sabe a qué producto apunta, el trabajo lo presenta y
-- la comparación por parecido sobra. Solo se adivina cuando no hay enlace.
create or replace function public.normalize_catalog_review_source_row_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  linked record;
begin
  if new.source_type <> 'enrichment_exception'
     or coalesce(new.context -> 'details' ->> 'source_scope', '') <> 'SOURCE_ROW' then
    return new;
  end if;

  select exception.product_id, exception.variant_id,
         product.name as product_name, product.code as product_code,
         variant.name as variant_name
  into linked
  from public.catalog_enrichment_exceptions exception
  left join public.products product on product.id = exception.product_id
  left join public.product_variants variant on variant.id = exception.variant_id
  where exception.id = new.source_id;

  if found and linked.product_id is not null then
    new.subject_type := 'product';
    new.subject_id := linked.product_id;
    new.context := coalesce(new.context, '{}'::jsonb)
      || jsonb_build_object('sourceRowLink', jsonb_strip_nulls(jsonb_build_object(
        'exact', true,
        'weakCount', 1,
        'clearCount', 1,
        'bestScore', 1,
        'candidates', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'productId', linked.product_id,
          'variantId', linked.variant_id,
          'name', linked.product_name,
          'variantName', linked.variant_name,
          'code', linked.product_code,
          'score', 1
        )))
      )));
    return new;
  end if;

  new.context := coalesce(new.context, '{}'::jsonb)
    || jsonb_build_object('sourceRowLink', public.catalog_review_source_row_link_v1(new.question));
  return new;
end;
$function$;

update public.catalog_review_work_items
set context = context
where source_type = 'enrichment_exception'
  and context -> 'details' ->> 'source_scope' = 'SOURCE_ROW'
  and status in ('open', 'in_progress');

-- El sujeto cambió de "otro" a un producto concreto, así que la relevancia
-- comercial se vuelve a calcular sobre el destino real.
update public.catalog_review_work_items
set business_relevance = public.catalog_review_commercial_weight_v1(
  subject_type, subject_id, context
)
where source_type = 'enrichment_exception'
  and context -> 'sourceRowLink' ->> 'exact' = 'true'
  and status in ('open', 'in_progress');

-- La compuerta de 0122 degradó estas preguntas porque no encontraba su sujeto.
-- Ahora lo tienen, así que vuelven a la Mesa. Las que sigan sin producto —una
-- fila que apuntaba a un artículo DEMO ya retirado— se quedan como deuda.
--
-- La compuerta solo sabe bajar: una vez degradado, un trabajo no regresa aunque
-- mejore su evidencia. Esa reposición se hace aquí a mano y queda anotada como
-- límite conocido del reprocesamiento.
with recuperados as (
  update public.catalog_review_work_items work
  set handling_class = 'human_exception',
      context = work.context || jsonb_build_object(
        'reprocessRule', 'source_row_subject_recovered',
        'reprocessClassification', 'human_exception'
      )
  where work.status in ('open', 'in_progress')
    and work.handling_class = 'automatic_debt'
    and work.context ->> 'reprocessRule' in (
      'source_row_reference_unresolvable', 'source_row_resemblance_too_weak'
    )
    and coalesce((work.context -> 'sourceRowLink' ->> 'exact')::boolean, false)
  returning work.id, work.work_key, work.row_version
)
insert into public.catalog_review_events(
  work_item_id, work_key, event_type, action_code, actor_label,
  idempotency_key, request_fingerprint, prior_version, new_version, payload
)
select
  recuperados.id, recuperados.work_key, 'work_reclassified',
  'source_row_subject_recovered', 'migration-0123',
  'migration-0123:' || recuperados.id::text,
  md5('0123:' || recuperados.id::text),
  recuperados.row_version - 1, recuperados.row_version,
  jsonb_build_object(
    'handlingClass', 'human_exception',
    'rule', 'source_row_subject_recovered',
    'reason', 'La fila fuente recuperó su producto interno desde el registro de reconciliación.'
  )
from recuperados;

revoke all on function public.normalize_catalog_review_source_row_v1()
  from public, anon, authenticated;

commit;
