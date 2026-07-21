# Migración de base de datos — Bellaroshe v1.0

Este directorio contiene una única migración: `0001_initial_catalog_backend.sql`.
Es el esquema base consolidado y autocontenido del catálogo Bellaroshe v1.0 para
Supabase/PostgreSQL.

## Qué crea

- Tipos: roles, disponibilidad de producto, estado de carta de colores y estado
  de exportación PDF.
- Tablas: perfiles de administrador, marcas, categorías, productos, imágenes de
  producto, configuración de tienda, metadatos del catálogo y exportaciones PDF.
- Relaciones, índices, restricciones y disparadores de actualización.
- RLS y políticas de lectura pública solo para contenido publicado; escritura
  exclusiva de administradores autenticados.
- Buckets de Storage `catalog-assets` y `catalog-pdfs`, junto con sus políticas.
- Privilegios explícitos para los roles `anon`, `authenticated` y `service_role`.

La fuente de datos inicial de marcas, categorías y configuración está en
`../seed.sql`. Los productos se cargan mediante el panel o
`scripts/seed-products.mjs`.

## Aplicación en una base nueva

Desde la raíz del proyecto, con Supabase CLI configurado:

```bash
supabase db reset
```

El comando crea el esquema con esta migración y después aplica `supabase/seed.sql`.
Para un proyecto remoto vacío se puede usar:

```bash
supabase db push
```

## Atención para una base ya existente

Esta consolidación no introduce cambios funcionales: integra en un único archivo
las migraciones históricas `0001`, `0002` y `0004`. No se debe ejecutar de nuevo
contra una base de producción que ya las tenga aplicadas, porque intentaría crear
objetos existentes.

Antes de adoptar este historial único en un proyecto remoto ya inicializado,
respalda la base y alinea el historial de `supabase_migrations.schema_migrations`
con el equipo. Para el uso cotidiano de esa base, no hace falta ejecutar ninguna
migración adicional; el SQL consolidado sirve como referencia canónica y como
bootstrap para entornos nuevos.

## Convenciones de mantenimiento

- Mantener este archivo como la referencia completa del esquema v1.0.
- Cualquier cambio posterior a la v1.0 debe ir en una nueva migración incremental;
  no se reescribe una migración que ya haya sido aplicada en producción.
- Las reglas de negocio y los contratos de API deben actualizarse junto con el SQL.
