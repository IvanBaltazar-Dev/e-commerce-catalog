-- ---------------------------------------------------------------------------
-- 0051 — El tono sale al catálogo público
--
-- La ficha pública sabía pintar círculos, pero no de qué color. El hex vive en
-- `color_shades.reference_color` desde 0009 y `catalog_product_detail_v2` nunca
-- lo devolvió: el público recibía nombre de tono y familia cromática, así que
-- el selector solo podía elegir entre la foto del envase o un tinte genérico
-- por familia. Con 164 tonos de Masglo eso obliga a una galería de 164
-- botellas — vidrio, etiqueta y tapa ocupando el sitio del color.
--
-- 0050 resolvió exactamente esto para el POS con `pos_product_tones`. Esta
-- migración lleva el MISMO material al público, con dos diferencias
-- deliberadas: aquí no hay sede ni stock (el público no ve cantidades) y el
-- contrato sigue siendo el de la ficha, no uno nuevo. Es enriquecimiento
-- aditivo de `catalog_product_detail_v2`; ningún campo existente cambia de
-- nombre, tipo ni orden, de modo que cualquier consumidor anterior sigue
-- funcionando sin tocarlo.
--
-- Qué se añade a cada variante:
--
--   `shade`  — el tono de la biblioteca: nombre comercial, código, color de
--              referencia y su familia cromática con el orden del diccionario
--              de 0011. `null` cuando la variante no es cromática (un polvo
--              acrílico por gramaje no tiene tono, y fingir uno sería mentir).
--
--   `finish` — el acabado (`finish_type` de 0013). Hoy ninguna variante lo
--              tiene cargado, y sale `null` a propósito: la pantalla decide con
--              este dato si el filtro de acabado existe o no. Un filtro
--              «Acabado» que no puede filtrar nada es una pantalla que miente,
--              y el día que la dueña cargue los acabados se enciende solo.
--
-- El color de referencia NO se deduce de la foto del envase. Vidrio, reflejos,
-- etiqueta y tapa contaminan cualquier promedio; el valor se registra una vez
-- en la biblioteca de tonos y se reutiliza. Esta función lo lee, no lo calcula.
--
-- `is_active` del tono no se filtra, igual que en 0050: quien decide si una
-- variante se publica es la variante. Desactivar un tono de la biblioteca no
-- debe dejar mudo un producto que sigue a la venta.
--
-- SECURITY DEFINER se conserva: lo fijó 0046 y `variant_effective_availability`
-- lo necesita para leer inventario desde anon. `set search_path = ''` obliga a
-- calificar cada referencia con su esquema.
-- ---------------------------------------------------------------------------

create or replace function public.catalog_product_detail_v2(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'productId', product.id,
    'code', product.code,
    'slug', product.slug,
    'name', product.name,
    'shortDescription', product.short_description,
    'description', product.description,
    'brand', jsonb_build_object(
      'id', brand.id,
      'name', brand.name,
      'slug', brand.slug
    ),
    'category', jsonb_build_object(
      'id', category.id,
      'name', category.name,
      'slug', category.slug,
      'path', category_path.canonical_path
    ),
    'template', jsonb_build_object(
      'id', template.id,
      'code', template.code,
      'name', template.name
    ),
    'attributes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'code', definition.code,
          'name', definition.name,
          'dataType', definition.data_type,
          'unit', definition.unit,
          'value', coalesce(
            to_jsonb(option.label),
            to_jsonb(value.value_text),
            to_jsonb(value.value_number),
            to_jsonb(value.value_boolean),
            to_jsonb(value.value_date),
            value.value_json
          )
        ) order by definition.sort_order, definition.name
      )
      from public.product_attribute_values value
      join public.attribute_definitions definition on definition.id = value.attribute_definition_id
      left join public.attribute_options option on option.id = value.option_id
      where value.product_id = product.id
    ), '[]'::jsonb),
    'media', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', media.id,
          'role', association.media_role,
          'path', media.storage_path,
          'mimeType', media.mime_type,
          'altText', media.alt_text,
          'isPrimary', association.is_primary
        ) order by association.media_role, association.is_primary desc, association.sort_order
      )
      from public.product_media association
      join public.media_assets media on media.id = association.media_asset_id
      where association.product_id = product.id
    ), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', variant.id,
          'sku', variant.sku,
          'name', variant.name,
          'variantKey', variant.variant_key,
          'availability', public.variant_effective_availability(variant.id),
          'isDefault', variant.is_default,
          -- NUEVO en 0051. `null` explícito cuando la variante no es cromática.
          'shade', case when shade.id is null then null else jsonb_build_object(
            'name', shade.name,
            'code', shade.code,
            'referenceColor', shade.reference_color,
            'familyValue', family_option.value,
            'familyLabel', family_option.label,
            'familySort', coalesce(family_option.sort_order, 9999)
          ) end,
          -- NUEVO en 0051. Hoy siempre `null`: nadie ha cargado finish_type.
          'finish', case when finish.value is null then null else jsonb_build_object(
            'value', finish.value,
            'label', finish.label
          ) end,
          'attributes', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'code', definition.code,
                'name', definition.name,
                'dataType', definition.data_type,
                'unit', definition.unit,
                'value', coalesce(
                  to_jsonb(option.label),
                  to_jsonb(value.value_text),
                  to_jsonb(value.value_number),
                  to_jsonb(value.value_boolean),
                  to_jsonb(value.value_date),
                  value.value_json
                ),
                'optionValue', option.value
              ) order by definition.sort_order, definition.name
            )
            from public.variant_attribute_values value
            join public.attribute_definitions definition on definition.id = value.attribute_definition_id
            left join public.attribute_options option on option.id = value.option_id
            where value.variant_id = variant.id
          ), '[]'::jsonb),
          'prices', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'priceListCode', price_list.code,
                'type', price_list.price_type,
                'amount', price.amount,
                'minimumQuantity', price.minimum_quantity,
                'currency', price_list.currency
              ) order by price_list.priority desc, price.minimum_quantity
            )
            from public.variant_prices price
            join public.price_lists price_list on price_list.id = price.price_list_id
            where price.variant_id = variant.id
              and price.is_active
              and price.validity @> now()
              and price_list.is_active
              and price_list.is_public
          ), '[]'::jsonb),
          'media', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', media.id,
                'role', association.media_role,
                'path', media.storage_path,
                'mimeType', media.mime_type,
                'altText', media.alt_text,
                'isPrimary', association.is_primary
              ) order by association.is_primary desc, association.sort_order
            )
            from public.product_media association
            join public.media_assets media on media.id = association.media_asset_id
            where association.variant_id = variant.id
          ), '[]'::jsonb)
        ) order by variant.is_default desc, variant.sort_order, variant.name
      )
      from public.product_variants variant
      left join public.color_shades shade on shade.id = variant.color_shade_id
      left join public.attribute_options family_option
        on family_option.id = shade.color_family_option_id
      left join lateral (
        select option.value, option.label
        from public.variant_attribute_values finish_value
        join public.attribute_definitions definition
          on definition.id = finish_value.attribute_definition_id
         and definition.code = 'finish_type'
        join public.attribute_options option on option.id = finish_value.option_id
        where finish_value.variant_id = variant.id
        limit 1
      ) finish on true
      where variant.product_id = product.id and variant.is_active
    ), '[]'::jsonb),
    'wholesaleRules', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', rule.id,
          'name', rule.name,
          'scopeType', rule.scope_type,
          'minimumQuantity', rule.minimum_quantity,
          'mixingPolicy', rule.mixing_policy,
          'priceListCode', price_list.code,
          'priority', rule.priority
        ) order by rule.priority desc, rule.minimum_quantity
      )
      from public.wholesale_rules rule
      join public.price_lists price_list on price_list.id = rule.price_list_id
      where rule.is_active
        and (rule.valid_from is null or rule.valid_from <= now())
        and (rule.valid_to is null or rule.valid_to > now())
        and (
          rule.product_id = product.id
          or rule.brand_id = product.brand_id
          or rule.category_id = product.category_id
          or rule.variant_id in (
            select variant.id from public.product_variants variant
            where variant.product_id = product.id and variant.is_active
          )
        )
    ), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', relation.id,
          'type', relation.relation_type,
          'compatibilityStatus', relation.compatibility_status,
          'sourceProductId', relation.source_product_id,
          'sourceVariantId', relation.source_variant_id,
          'targetProductId', relation.target_product_id,
          'targetVariantId', relation.target_variant_id,
          'notes', relation.notes
        ) order by relation.sort_order, relation.id
      )
      from public.product_relations relation
      where relation.is_active
        and (
          relation.source_product_id = product.id
          or relation.target_product_id = product.id
          or relation.source_variant_id in (
            select variant.id from public.product_variants variant where variant.product_id = product.id
          )
          or relation.target_variant_id in (
            select variant.id from public.product_variants variant where variant.product_id = product.id
          )
        )
    ), '[]'::jsonb)
  )
  from public.products product
  join public.brands brand on brand.id = product.brand_id
  join public.categories category on category.id = product.category_id
  join public.attribute_templates template on template.id = product.template_id
  left join public.category_paths category_path on category_path.id = category.id
  where product.slug = p_slug
    and product.is_active
    and product.editorial_status = 'published';
$$;

comment on function public.catalog_product_detail_v2(text) is
  'Ficha pública de un producto publicado. Desde 0051 cada variante lleva su '
  'tono (nombre, código, color de referencia y familia cromática) y su acabado, '
  'para que el selector pueda ser una carta de colores y no una galería de '
  'envases. El color de referencia se lee de la biblioteca de tonos: nunca se '
  'deduce de la fotografía.';

-- Los privilegios los fijaron 0006 y 0045; `create or replace` los conserva.
-- Se reafirman porque una función pública sin `execute` para anon deja la ficha
-- en 404 silencioso, y es barato dejarlo escrito.
revoke execute on function public.catalog_product_detail_v2(text) from public;
grant execute on function public.catalog_product_detail_v2(text)
to anon, authenticated, service_role;
