#!/usr/bin/env bash
# Varias pasadas sobre el mismo sitemap hasta que deje de aparecer nada nuevo.
#
# El rastreo es reanudable, así que cada pasada solo pide lo que aún no está en
# caché. Insistir dentro de una pasada sale caro (el limitador estrangula justo
# cuando más se insiste); volver a pasar más tarde sale barato.
#
# Se para cuando una pasada no añade ni una ficha: eso es el techo real de lo que
# la fuente entrega, y seguir solo gastaría cuota.
tienda="${1:-bellespa}"
max="${2:-8}"
dir="outputs/cache/sitemap-$tienda"
for i in $(seq 1 "$max"); do
  antes=$(ls "$dir" 2>/dev/null | wc -l)
  echo "── pasada $i · $antes fichas en caché ──"
  node --experimental-transform-types scripts/captura-sitemap-sumerlabs.mjs "$tienda" --aplicar 2>&1 \
    | grep -vE "ExperimentalWarning|Reparsing|--trace-warnings|^\(node:"
  codigo=${PIPESTATUS[0]}
  despues=$(ls "$dir" 2>/dev/null | wc -l)
  echo "── pasada $i: $antes → $despues (+$((despues-antes))) · salida $codigo ──"
  [ "$codigo" = "0" ] && { echo "COMPLETA y persistida en la pasada $i"; exit 0; }
  [ "$despues" = "$antes" ] && { echo "pasada sin ganancia: techo de la fuente en $despues"; exit 1; }
  # Enfriamiento. El limitador es acumulativo: seguir pidiendo justo después de
  # una pasada solo consigue que la siguiente rinda peor. Esperar es más rápido
  # que insistir, por poco intuitivo que suene.
  if [ "$i" != "$max" ]; then echo "   enfriando 10 min…"; sleep 600; fi
done
echo "agotadas las $max pasadas"; exit 1
