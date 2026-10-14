# AXOL - Corregir el usuario de GitHub en todos los archivos
$ErrorActionPreference = 'Stop'
$Dev = (Split-Path $PSScriptRoot -Qualifier) + '\AxolDev'
if (-not (Test-Path $Dev)) { $Dev = Split-Path $PSScriptRoot -Parent }
Write-Host "Carpeta: $Dev"
$Malo  = (Read-Host "Usuario MAL escrito (ej. axolstudio)").Trim()
$Bueno = (Read-Host "Usuario CORRECTO de GitHub (ej. axolstudios)").Trim()
if (-not $Malo -or -not $Bueno -or $Malo -eq $Bueno) { throw "Datos no validos." }
$Utf8 = New-Object System.Text.UTF8Encoding $false
# Solo reemplaza el nombre completo (axolstudio no toca axolstudios)
$Patron = '(?i)(?<![A-Za-z0-9-])' + [regex]::Escape($Malo) + '(?![A-Za-z0-9-])'
$Archivos = @(
  "$Dev\Nebula\.env",
  "$Dev\axol-launcher\app\assets\js\axolconfig.js",
  "$Dev\axol-launcher\electron-builder.yml",
  "$Dev\axol-launcher\dev-app-update.yml",
  "$Dev\axol-launcher\package.json"
)
foreach ($f in $Archivos) {
  if (-not (Test-Path $f)) { continue }
  $t = [System.IO.File]::ReadAllText($f)
  $n = [regex]::Replace($t, $Patron, $Bueno.ToLower())
  if ($n -ne $t) { [System.IO.File]::WriteAllText($f, $n, $Utf8); Write-Host "  Corregido: $f" -ForegroundColor Green }
}
Write-Host ""
Write-Host "Revisa la URL del launcher:" -ForegroundColor Yellow
Select-String -Path "$Dev\axol-launcher\app\assets\js\axolconfig.js" -Pattern 'DISTRIBUTION_URL' | ForEach-Object { $_.Line.Trim() }
Select-String -Path "$Dev\Nebula\.env" -Pattern 'BASE_URL' | ForEach-Object { $_.Line.Trim() }
Write-Host ""
Write-Host "Ahora: 1) publicar.bat   2) COMPILAR.bat" -ForegroundColor Cyan
Read-Host "Enter para salir" | Out-Null
