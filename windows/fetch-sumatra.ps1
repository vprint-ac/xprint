param(
  [string]$Destination = (Join-Path $PSScriptRoot 'bin')
)

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -Raw (Join-Path $PSScriptRoot 'sumatra.json') | ConvertFrom-Json
$zip = Join-Path $Destination 'SumatraPDF-3.6.1-64.zip'
$exe = Join-Path $Destination $manifest.exe

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
if (-not (Test-Path $exe)) {
  Invoke-WebRequest -Uri $manifest.url -OutFile $zip -UseBasicParsing
  $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $manifest.sha256) {
    throw "SumatraPDF archive hash mismatch: expected $($manifest.sha256), got $hash"
  }
  Expand-Archive -Path $zip -Destination $Destination -Force
  Remove-Item $zip
}

$actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $manifest.exeSha256) {
  throw "SumatraPDF executable hash mismatch: expected $($manifest.exeSha256), got $actual"
}

$signature = Get-AuthenticodeSignature $exe
if ($signature.Status -ne 'Valid') {
  throw "SumatraPDF Authenticode status is $($signature.Status)"
}
$subject = $signature.SignerCertificate.Subject
if ($subject -notmatch [regex]::Escape("CN=$($manifest.signer)")) {
  throw "SumatraPDF signer is not $($manifest.signer): $subject"
}

Write-Host "verified $($manifest.exe) $($manifest.version) sha256=$actual signer=$subject"
