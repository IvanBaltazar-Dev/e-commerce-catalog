# Bandeja manual de investigación de productos

Esta carpeta conserva la información bruta dictada durante las revisiones del
catálogo para investigarla y procesarla en sesiones posteriores sin convertir
un apunte en una decisión canónica por accidente.

## Archivos

- `apuntes-productos.md`: lectura humana, razonamiento preliminar y pendientes.
- `casos.jsonl`: una línea JSON por caso para búsquedas y procesamiento masivo.

## Estados

- `CAPTURADO`: la información fue guardada, pero no se cambió el catálogo.
- `INVESTIGAR`: faltan consultas o comprobaciones externas.
- `LISTO_PARA_DECIDIR`: la evidencia permite recomendar una acción.
- `APLICADO`: la decisión ya fue registrada en el sistema.
- `BLOQUEADO`: falta una evidencia que no puede obtenerse todavía.

## Forma de trabajo

1. Durante el dictado se conserva el nombre, marca, línea, presentación,
   códigos, enlaces, alternativas, contradicciones y cualquier observación.
2. La investigación posterior comprueba primero la fuente oficial y después
   distribuidores o fuentes secundarias cuando hagan falta.
3. Las imágenes remotas se inventarían con su URL y procedencia. Descargar una
   imagen no la vuelve publicable: antes se calcula hash, se normaliza y se
   revisa.
4. La decisión de familia se separa de la conciliación de variante o tono. Que
   un tono pertenezca a una familia no significa que sea el mismo tono que una
   variante interna mostrada como ejemplo.
5. Solo los casos marcados expresamente como `APLICADO` deben considerarse
   cambios reales del catálogo.

Para agregar información nueva basta dictarla en texto libre. Se asignará un
`case_id`, se conservará el apunte y se completarán únicamente los campos que
la evidencia permita sostener.
