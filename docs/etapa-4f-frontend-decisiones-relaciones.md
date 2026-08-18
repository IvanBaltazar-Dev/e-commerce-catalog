# Etapa 4F · Frontend real de decisiones de relaciones

**Contrato consumido:** `stage4e-v1`

**Ruta:** `Catálogo → Revisar → Decisiones de relaciones`

**Estado:** implementada y técnicamente certificada; medición humana previa a producción pendiente

## Resultado de producto

La propietaria puede revisar las 18 decisiones reales sin salir del lenguaje visual actual de Bellaroshé. La pantalla es clara, breve y progresiva:

1. La cola muestra causa, problema y alcance.
2. La decisión explica **Qué problema corrige**, **Qué recomendamos** y **Qué va a resolver**.
3. El tratamiento de productos dudosos aparece antes de las acciones.
4. Productos, evidencia e historial permanecen cerrados hasta que la persona decide profundizar.

No se muestran `rule_code`, fingerprints, códigos de acción ni etiquetas epistemológicas en el recorrido principal.

## Decisión no binaria

La persona puede:

- seguir la recomendación;
- elegir una alternativa y dejar el comentario requerido;
- añadir un comentario opcional a una aceptación;
- **anotar y guardar pendiente**, indicando qué falta y cuándo volver;
- reanudar un caso aplazado;
- volver sin guardar, con advertencia si existe texto pendiente.

Guardar pendiente nunca resuelve el caso. La nota y la fecha regresan desde la Mesa y el historial conserva cada evento.

## Aplicación segura

La UI no aplica directamente una decisión. Primero solicita el preview al backend y muestra el alcance. Solo después habilita **Confirmar decisión**. Las claves de idempotencia se conservan durante reintentos de preview, apply, aplazamiento y reanudación; una respuesta de red perdida no cambia la intención enviada.

El endpoint administrativo ejecuta apply, sincroniza Neo4j y verifica el resultado. Si la evidencia cambió, la interfaz informa que el caso quedó obsoleto, descarta la pantalla antigua y carga la versión vigente.

## Estados cubiertos

- cola con decisiones y cola vacía;
- caso revisable y caso aplazado;
- comentario opcional y obligatorio;
- formulario de guardado pendiente;
- preview y confirmación;
- éxito verificado;
- versión obsoleta, conflicto y error;
- carga diferida de expediente;
- advertencia por texto sin guardar;
- reintentos con la misma intención idempotente.

## Implementación

- `CatalogRelationDecisionReviewView.tsx` contiene únicamente estado de presentación e intenciones.
- `/api/admin/catalog-review/relations` es la frontera HTTP administrativa.
- `catalog-relation-decision-service.ts` adapta RPC PostgreSQL a tipos de UI.
- El acceso se limita a `admin` y `developer` mediante el contexto existente del panel.
- Los estilos reutilizan Manrope, porcelana, rosa, radios, navegación y densidad de `Catálogo → Revisar`; no existe tema oscuro alternativo.

## Validación

Tipo y lint pasan. La inspección en el navegador real verificó las 18 tarjetas, las tres familias, evidencia cerrada por defecto, lenguaje natural, ausencia de términos descartados y cero desborde horizontal con viewport móvil de 375 px. El recorrido automatizable vive en `scripts/test-catalog-relation-decisions-ui.mjs`; el navegador Edge de esta máquina no permitió a Puppeteer iniciar una sesión independiente, por lo que la comprobación visual se ejecutó con el navegador integrado y el script queda disponible para CI o una máquina con Chrome controlable.

La inspección real en escritorio y móvil, el contrato de servidor, tipos y lint cierran el gate técnico que habilita la expansión controlada. La medición presencial de comprensión y decisión en menos de un minuto sigue siendo una validación humana de producto previa a producción; no se sustituye con una prueba técnica ni bloquea Etapa 5.
