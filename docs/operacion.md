# Bellaroshé — Manual de operación

**Última revisión:** Bloque 5 (2026-08-07). Este documento es el runbook: cómo se instala, despliega, respalda, restaura y diagnostica la plataforma. La arquitectura es **Next.js 15 + Supabase (PostgreSQL/RLS)** — decisión ratificada desde la auditoría inicial: se evoluciona esta plataforma, no se reconstruye.

---

## 1. Entornos

```
LOCAL       → desarrollo y pruebas destructivas (Supabase local en Docker)
STAGING     → réplica funcional SIN datos productivos (proyecto Supabase propio)
PRODUCCIÓN  → operación real (proyecto Supabase propio)
```

Regla dura: **staging y producción no comparten base, buckets ni secretos.** Cada entorno tiene su proyecto Supabase, sus claves y sus variables en el gestor del hosting. Ninguna clave vive en el repositorio.

| Variable | Local | Staging/Prod |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` | `http://127.0.0.1:55321` | URL del proyecto |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | de `npx supabase status` | anon del proyecto |
| `SUPABASE_SERVICE_ROLE_KEY` | de `npx supabase status` | **solo** gestor de secretos del servidor |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | dominio del entorno |
| `ANTHROPIC_API_KEY` | opcional (sin ella: IA degradada) | opcional; solo servidor |
| Secretos WhatsApp/Meta/TikTok | opcionales | por entorno, jamás compartidos |

La plantilla completa vive en [.env.example](../.env.example). El puerto local es la banda 55320–55329 (Windows reserva 54234–54333; ver `supabase/config.toml`).

## 2. Procedimiento local (máquina nueva)

```
git clone <repo> && cd e-commerce-catalog
npm install
npx supabase start                  # primera vez descarga contenedores
npx supabase status                 # copiar anon y service_role
cp .env.example .env.local          # pegar las claves locales
cp .env.example .env.supabase.local # ídem (los guiones .mjs leen este)
npx supabase db reset --local       # 0001–0046 + seed base
npm run seed:demo-operation         # operación demo (usuarios, stock, ventas)
npm run build && npm run start -- -p 3002
```

Credenciales demo: `demo-admin@local.invalid` / `Demo-Admin-2026!` y `demo-seller@local.invalid` / `Demo-Seller-2026!`.

**Navegador de pruebas/PDF:** `npx puppeteer browsers install chrome` (o `PUPPETEER_EXECUTABLE_PATH` a un Chrome/Edge). Los guiones resuelven en ese orden (`scripts/lib/resolve-browser.mjs`); en serverless el PDF usa `@sparticuz/chromium` automáticamente.

## 3. Pruebas

| Comando | Qué prueba |
|---|---|
| `npm run gate:rebuild` | **El gate del Bloque 5**: base vacía → migraciones → seeds → pgTAP → integrales B1–B4 → concurrencias → typecheck → lint → build. Evidencia en `test-results/gate-rebuild-N.md` |
| `npm run test:db` | pgTAP completo (20 suites, 505 aserciones) |
| `test:contracts` / `test:block2` / `test:block3` / `test:block4` | Integrales por bloque |
| `test:inventory-concurrency` / `test:sales-concurrency` / `test:omnichannel-concurrency` | Concurrencia con sesiones reales |
| `test:ai-matching` | Intérprete determinista de pedidos (sin IA) |
| `test:sales-ui` / `test:analytics-ui` / `test:assistant-ui` / `test:admin-flow` | Pantallas con sesión real (requieren servidor en `UI_BASE_URL`, por omisión :3002) |
| `npm run audit:security` | Auditoría estructural (RLS, ACL, DEFINER, bundle) contra línea base versionada |
| `npm run perf:volume` | Rendimiento con ~1,500 SKUs + 5,000 ventas + 2,000 conversaciones |
| `npm run backup:verify` | pg_dump y **restauración real** verificada por conteos |

## 4. Backup y restore

**Backup:** `npm run backup:verify` genera `backups/bellaroshe-<fecha>.dump` (pg_dump -Fc) y lo **restaura de verdad** en una base de verificación, comparando conteos de las 12 tablas críticas. Un dump que no pasó por ese ciclo no cuenta como backup.

**Remoto:** `PG_BACKUP_URL=postgres://…` usa pg_dump/pg_restore del sistema contra el proyecto (la cadena de conexión directa está en Supabase → Settings → Database). Programar diario en producción y ANTES de toda migración.

**Restore de producción (incidente):** restaurar el dump en un proyecto/base NUEVO, verificar conteos, apuntar la aplicación al restaurado (cambio de variables + redeploy). Jamás restaurar «encima» del proyecto dañado sin copia del estado dañado.

## 5. Migraciones — clasificación y despliegue remoto

Las migraciones 0001–0046 son **aditivas** con estas excepciones conocidas:

| Migración | Naturaleza | Precaución en producción |
|---|---|---|
| `0029` | **DESTRUCTIVA**: `drop table orders, order_items` (legado del catálogo V1) | Exportar esas dos tablas ANTES (`pg_dump -t public.orders -t public.order_items`). Es el único drop de datos del recorrido |
| `0012–0015` | Correcciones de diccionarios (DELETE de opciones/atributos propios) | Idempotentes; verificadas en el gate de reconstrucción |
| `0037`, `0042` | DELETE quirúrgicos de su propio dominio (carritos huérfanos, cadenas duplicadas) | Parte del contrato; cubiertas por pgTAP |
| Índices | `create index` clásico (bloquea escrituras durante la creación) | Tablas actuales chicas: segundos. Índices futuros sobre tablas grandes: `CREATE INDEX CONCURRENTLY` fuera de transacción |

No hay `ALTER COLUMN TYPE` ni `ADD COLUMN NOT NULL` sin default (cero rewrites de tabla).

**Procedimiento de despliegue remoto (staging primero, SIEMPRE):**

```
1. npm run backup:verify                        # con PG_BACKUP_URL del entorno
2. npx supabase migration list --linked          # inventario aplicado vs repo
3. Ensayo COMPLETO en staging (mismas migraciones pendientes)
4. Si toca 0029 sobre datos reales: export previo de orders/order_items
5. npx supabase db push --linked                 # aplicar
6. npm run audit:security                        # con PG_AUDIT_URL del entorno
7. Recorrido E2E de humo + redeploy del frontend
```

**Prohibido:** ejecutar `seed-demo-operation` fuera de local; editar filas a mano para «arreglar» producción — toda corrección va por migración o por los contratos.

## 6. Deploy y rollback del frontend

El frontend es Next.js: cada deploy es inmutable y el rollback es **redeploy del build anterior** (en Vercel: Promote de la deployment previa; en cualquier host: re-publicar el artefacto anterior). Las cinco situaciones ensayadas:

| Caso | Estrategia |
|---|---|
| **A. Frontend defectuoso** | Rollback de plataforma al build anterior. La base no se toca |
| **B. Migración aún no ejecutada** | No hay nada que revertir en la base: solo frontend (caso A) |
| **C. Migración ejecutada y frontend nuevo falla** | Las migraciones son aditivas → el frontend ANTERIOR sigue funcionando sobre el esquema nuevo; rollback de frontend y se corrige con calma. Si la migración fuera destructiva (tipo 0029): restaurar desde backup + redeploy anterior — por eso el backup pre-migración es obligatorio |
| **D. `ANTHROPIC_API_KEY` ausente/incorrecta** | NO es incidente: la plataforma degrada por diseño (regla 10) — intérprete/asesora deterministas, visión «no disponible», todo registrado. Vender jamás depende de la IA |
| **E. Supabase inaccesible** | El frontend responde errores claros con `requestId`; no hay estado que corromper. Se espera la recuperación del servicio o se restaura en proyecto nuevo (§4). Verificar `status.supabase.com` |

## 7. IA (`ANTHROPIC_API_KEY`)

- Opcional **por diseño**. Sin ella: intérprete y asesora en modo determinista declarado, visión «no disponible», evidencia registrada con `provider_status`.
- Solo servidor. Jamás `NEXT_PUBLIC_`. El único módulo que la toca es `src/lib/ai/provider.ts` (modelo `claude-opus-5`).
- Costos y latencia quedan por interacción en `ai_interactions` (modelo, `latency_ms`).

## 8. Observabilidad

- Toda respuesta de API lleva `x-request-id` (el middleware lo genera o adopta el del proxy). El mismo id aparece en el JSON de error y en la línea de log — un pantallazo basta para correlacionar.
- Log estructurado (una línea JSON en stdout/stderr — lo que Vercel/Supabase capturan): clases `http_5xx`, `rpc_error`, `ai_failure` (distinta de fallo operacional, regla 10), `pdf_failure`, `storage_failure`. Sin payloads sensibles (§44).
- Auditoría de operaciones críticas: ya vive en la base (kardex, `channel_events`, `conversation_assignments`, `ai_interactions`, `content_proposals` — append-only con actor).

## 9. Troubleshooting

| Síntoma | Causa probable | Acción |
|---|---|---|
| `supabase start` no levanta | Puertos ocupados / Docker apagado | Docker Desktop encendido; la banda es 55320–55329 |
| Guiones fallan con «Could not find Chrome» | Sin navegador resuelto | `npx puppeteer browsers install chrome` o `PUPPETEER_EXECUTABLE_PATH` |
| Push de git se cuelga | GCM sin usuario | `git config credential.https://github.com.username=<usuario>` |
| Pantallas admin con «cero filas» | Rol/RLS: el usuario no es staff activo o no tiene sede | revisar `admin_profiles.is_active` y `staff_branches` |
| IA «Modo determinista» | Sin `ANTHROPIC_API_KEY` | Es el diseño; añadir la clave la activa sin tocar código |
| Error con `requestId` en pantalla | — | grep del id en los logs del servidor (clase + código + mensaje) |
| `db reset` falla a mitad | contenedor en mal estado | `npx supabase stop --no-backup && npx supabase start` |

## 10. Estado de la migración a producción

**PRODUCCIÓN: NO TOCAR** hasta superar los gates de staging (ver `docs/bloque-5-ejecucion.md`). El proyecto Supabase remoto del catálogo antiguo existe; su `service_role` fue puesta en cuarentena fuera del repo (R-12) y **debe rotarse** antes de cualquier trabajo remoto.
