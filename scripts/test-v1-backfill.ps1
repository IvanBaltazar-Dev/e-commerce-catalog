$ErrorActionPreference = "Stop"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command,
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description falló con código $LASTEXITCODE."
  }
}

$testFailed = $false

try {
  Invoke-Checked { npx.cmd supabase db reset --local --version 0004 --no-seed } "Reset hasta 0004"
  Invoke-Checked { node scripts/seed-v1-backfill-fixtures.mjs --env .env.supabase.local } "Carga de fixtures V1"
  Invoke-Checked { npx.cmd supabase migration up --local } "Aplicación de 0005"
  Invoke-Checked { node scripts/verify-v1-backfill.mjs --env .env.supabase.local } "Verificación del backfill"
} catch {
  $testFailed = $true
  Write-Error $_
} finally {
  & npx.cmd supabase db reset --local
  if ($LASTEXITCODE -ne 0) {
    throw "No se pudo restaurar la base local completa después de la prueba."
  }
}

if ($testFailed) {
  exit 1
}

Write-Host "Prueba histórica de backfill completada y base local restaurada."
