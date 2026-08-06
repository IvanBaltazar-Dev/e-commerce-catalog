# Migraciones de base de datos — Bellaroshe

Este directorio conserva el historial real aplicado del catálogo Bellaroshe.
Las migraciones `0001`, `0002` y `0004` representan V1 y deben permanecer
inmutables. El modelo V2 comienza en `0005_catalog_v2.sql`.

## Historial

- `0001_initial_catalog_backend.sql`: esquema inicial V1.
- `0002_columns_and_grants.sql`: columnas y privilegios añadidos a V1.
- `0004_harden_product_image_read_policy.sql`: endurecimiento de lectura pública.
- `0005_catalog_v2.sql`: modelo V2 aditivo y backfill de V1.
- `0006_catalog_v2_contracts.sql`: consultas agregadas de listado, detalle y carrito.
- `0007_admin_orders.sql`: pedidos administrativos, líneas, estados, RLS y alta transaccional.
- `0008_product_registration_foundations.sql`: líneas comerciales, ocho plantillas de alta, atributos controlados y categorías internas para el registro guiado.
- `0009_scoped_brands_and_color_library.sql`: marcas y líneas por múltiples familias, marca genérica y biblioteca normalizada de tonos.
- `0010_enforce_color_shade_scope.sql`: integridad entre tono, marca, línea comercial y variante.
- `0011_color_family_dictionary.sql`: diccionario cromático completo y obligatorio para tonos de esmalte.
- `0012_correct_admiss_family.sql`: corrige Admiss como marca de esmaltes y elimina su asociación errónea con tornos.
- `0013_enamel_content_and_finishes.sql`: contenido numérico con unidad para esmaltes y diccionario ampliable de acabados.
- `0014_conditional_attribute_rules.sql`: reglas condicionales tipadas y validación de coherencia entre atributos.
- `0015_product_form_attribute_coherence.sql`: limpieza de atributos retirados, reglas numéricas y de rangos, dependencias por alimentación y asociaciones deterministas de potencia/voltaje.
- `0019_json_attribute_values.sql`: incorpora valores JSON tipados para atributos estructurados.
- `0020_enamel_catalog_details.sql`: agrega detalles comerciales y por tono reutilizables para la familia de esmaltes, incluido el par fotocromático.
- `0021_contextual_product_relations.sql`: uso y alcance de marca de adhesivos para recomendaciones contextuales seguras.
- `0022_accessory_relation_domain.sql`: clasifica accesorios por área de uso para evitar relaciones incoherentes entre pestañas, uñas, barbería y equipos.

La fuente de datos inicial de marcas, categorías y configuración está en
`../seed.sql`. Los productos se cargan mediante el panel o
`scripts/seed-products.mjs`.

## Aplicación en una base nueva

Desde la raíz del proyecto, con Supabase CLI configurado:

```bash
supabase db reset
```

El comando crea el esquema con esta migración y después aplica `supabase/seed.sql`.
Durante el desarrollo V2 solo se debe trabajar contra Supabase local. No se debe
ejecutar `db push` contra producción hasta completar la validación formal.

## Convenciones de mantenimiento

- No modificar, consolidar, renombrar ni eliminar `0001`, `0002` o `0004`.
- Cada cambio posterior debe ir en una migración incremental nueva.
- Las reglas de negocio y los contratos de API deben actualizarse junto con el SQL.
