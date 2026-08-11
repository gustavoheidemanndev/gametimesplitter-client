# Copia o instalador e os metadados de auto-update de release/ para a pasta que o backend
# publica em /downloads. O electron-updater dos clientes instalados lê latest.yml desse
# endereço, então o .exe e o latest.yml precisam ser publicados sempre juntos.
[CmdletBinding()]
param(
  # Destino alternativo, útil para conferir o resultado antes de mexer na pasta publicada.
  [string]$DestinationDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $desktopRoot
$releaseDirectory = Join-Path $desktopRoot 'release'
$downloadsDirectory = if ($DestinationDirectory) {
  $DestinationDirectory
} else {
  Join-Path (Join-Path (Join-Path $repositoryRoot 'backend') 'public') 'downloads'
}

$version = (Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json).version
if (-not $version) { throw 'Não foi possível ler a versão em desktop-client/package.json.' }

$installerName = "Game Time Splitter-Setup-$version.exe"
$installerPath = Join-Path $releaseDirectory $installerName
$blockmapPath = "$installerPath.blockmap"
$latestPath = Join-Path $releaseDirectory 'latest.yml'

if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "Instalador não encontrado: $installerPath. Rode 'npm run dist' antes de publicar."
}
if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) {
  throw "latest.yml não encontrado em $releaseDirectory. Sem ele o auto-update não funciona: confirme o bloco 'publish' em electron-builder.yml e rode 'npm run dist' de novo."
}

# electron-builder grava o sha512 do instalador em latest.yml. Se os dois não combinarem,
# todo cliente baixa a atualização e falha na verificação de integridade.
$sha512Hex = (Get-FileHash -Algorithm SHA512 -LiteralPath $installerPath).Hash
$sha512Bytes = [byte[]]::new($sha512Hex.Length / 2)
for ($index = 0; $index -lt $sha512Bytes.Length; $index++) {
  $sha512Bytes[$index] = [Convert]::ToByte($sha512Hex.Substring($index * 2, 2), 16)
}
$sha512 = [Convert]::ToBase64String($sha512Bytes)

$latestContent = Get-Content -LiteralPath $latestPath -Raw
$declaredVersion = ([regex]::Match($latestContent, '(?m)^version:\s*(?<value>\S+)\s*$')).Groups['value'].Value
if ($declaredVersion -ne $version) {
  throw "latest.yml aponta para a versão '$declaredVersion', mas o pacote é '$version'. Rode 'npm run dist' para regerar os dois juntos."
}
if (-not $latestContent.Contains($sha512)) {
  throw "O sha512 em latest.yml não corresponde a $installerName. Rode 'npm run dist' para regerar o instalador e os metadados juntos."
}

if (-not (Test-Path -LiteralPath $downloadsDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $downloadsDirectory -Force | Out-Null
}

$publishedFiles = @($installerPath, $latestPath)
if (Test-Path -LiteralPath $blockmapPath -PathType Leaf) {
  # O blockmap permite download diferencial: sem ele o cliente baixa o instalador inteiro.
  $publishedFiles += $blockmapPath
} else {
  Write-Warning "Blockmap ausente ($blockmapPath); os clientes farão o download completo."
}

foreach ($file in $publishedFiles) {
  Copy-Item -LiteralPath $file -Destination $downloadsDirectory -Force
  Write-Host "Publicado: $(Split-Path -Leaf $file)"
}

# O endpoint /api/desktop/download expõe este checksum na página de download da web.
$publishedInstaller = Join-Path $downloadsDirectory $installerName
$sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $publishedInstaller).Hash
Set-Content -LiteralPath "$publishedInstaller.sha256" -Value "$sha256  $installerName" -Encoding ascii
Write-Host "Publicado: $installerName.sha256"

Write-Host ''
Write-Host "Versão $version pronta em $downloadsDirectory."
Write-Host 'Faça o deploy do backend para que os clientes instalados encontrem o novo latest.yml.'
