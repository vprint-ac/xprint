param(
  [Parameter(Mandatory = $true)]
  [string]$Xprint,
  [string]$WorkDir = (Join-Path ([System.IO.Path]::GetTempPath()) 'xprint-acceptance')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Microsoft Print to PDF receives a bitmap from SumatraPDF (Print.cpp renders the
# page and calls RenderedBitmap::Blit), so the output has no extractable text.
# Page count comes from pdfinfo and the last page is checked by OCR instead.
# These tools are CI prerequisites and are never needed by the xprint CLI itself.

function Assert-That {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
  Write-Host "ok - $Message"
}

# Native tools write progress and warnings to stderr. Under ErrorActionPreference
# Stop, Windows PowerShell 5.1 turns any stderr line into a terminating error, so
# each call runs with Continue and reports through its exit code and output.
function Invoke-Tool {
  param([string]$File, [string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $File @Arguments 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Invoke-Xprint {
  param([string]$Directory, [string[]]$Arguments)
  Push-Location $Directory
  $originalPath = $env:Path
  try {
    # Keep only the OS printing tools on the CLI's PATH. Poppler and OCR are
    # separate checks performed by the harness after restoring the caller PATH.
    $env:Path = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\Wbem;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
    if ((Get-Command bun,typst -ErrorAction SilentlyContinue)) { throw 'Unexpected runtime in isolated PATH' }
    return Invoke-Tool -File $script:Xprint -Arguments $Arguments
  } finally {
    $env:Path = $originalPath
    Pop-Location
  }
}

function New-ContestDirectory {
  param([string]$Name, [string]$Printer, [string]$Source, [string]$Config)
  $directory = Join-Path $WorkDir $Name
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  if ($Source) {
    Copy-Item -LiteralPath $Source -Destination (Join-Path $directory 'layout.cpp')
  } else {
    Set-Content -LiteralPath (Join-Path $directory 'A.cpp') -Encoding UTF8 -Value @(
      '#include <cstdio>',
      '// 中文注释：输出问候',
      'int main() {',
      '  for (int i = 0; i < 3; ++i) puts("hello");',
      '  // 一行足够长的代码，用来检查换行与页眉：' + ('x' * 160),
      '  return 0;',
      '}'
    )
  }
  if ($Config) {
    Set-Content -LiteralPath (Join-Path $directory '.xprint.yaml') -Encoding UTF8 -Value $Config
  } elseif ($Printer) {
    Set-Content -LiteralPath (Join-Path $directory '.xprint.yaml') -Encoding UTF8 -Value "printer: `"$Printer`""
  }
  return $directory
}

# EndDoc can return while the spooler still owns an empty output file.
function Wait-ForPdf {
  param([string]$Path, [string]$Queue)
  $deadline = (Get-Date).AddMinutes(3)
  do {
    try {
      $stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
      try {
        if ($stream.Length -ge 5) {
          $length = [int][Math]::Min(1024L, $stream.Length)
          $null = $stream.Seek(-$length, [IO.SeekOrigin]::End)
          $tail = [byte[]]::new($length)
          $read = $stream.Read($tail, 0, $length)
          if ([Text.Encoding]::ASCII.GetString($tail, 0, $read) -match '%%EOF\s*\z') { return }
        }
      } finally {
        $stream.Dispose()
      }
    } catch [IO.IOException] {
      # The spooler has yet to create or close this output.
    }
    Start-Sleep -Milliseconds 400
  } while ((Get-Date) -lt $deadline)
  $jobs = Get-PrintJob -PrinterName $Queue | Select-Object ID,JobStatus | Out-String
  throw "Timed out waiting for a complete PDF at $Path from $Queue. Jobs: $jobs"
}

function Get-DefaultPrinterName {
  param([switch]$Optional)
  $printer = if ($Optional) {
    Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object Default | Select-Object -First 1
  } else {
    Get-CimInstance Win32_Printer | Where-Object Default | Select-Object -First 1
  }
  if ($null -eq $printer) { return $null }
  return [string]$printer.Name
}

function Set-DefaultPrinter {
  param([string]$Name)
  $rundll32 = Join-Path $env:SystemRoot 'System32\rundll32.exe'
  $argument = "printui.dll,PrintUIEntry /y /n `"$Name`""
  $process = Start-Process -FilePath $rundll32 -ArgumentList $argument -Wait -PassThru -WindowStyle Hidden
  return [pscustomobject]@{ ExitCode = $process.ExitCode; Readback = (Get-DefaultPrinterName) }
}

function Assert-PdfOutput {
  param([string]$Path, [int]$ExpectedPages, [string]$Marker, [string]$EvidencePrefix)
  Assert-That ((Get-Item -LiteralPath $Path).Length -gt 0) "$Path is not empty"
  $info = Invoke-Tool pdfinfo @($Path)
  Assert-That ($info.ExitCode -eq 0) "pdfinfo reads $Path ($($info.Output.Trim()))"
  $pages = [regex]::Match($info.Output, '(?m)^Pages:\s+(\d+)\s*$')
  Assert-That $pages.Success "pdfinfo reports a page count"
  Assert-That ([int]$pages.Groups[1].Value -eq $ExpectedPages) "$Path has $ExpectedPages pages (got $($pages.Groups[1].Value))"
  # Render the last page at 200 dpi and OCR only the ASCII marker on it.
  $rendered = Invoke-Tool pdftoppm @('-f', "$ExpectedPages", '-l', "$ExpectedPages", '-r', '200', '-png', $Path, $EvidencePrefix)
  Assert-That ($rendered.ExitCode -eq 0) "pdftoppm renders the last page of $Path ($($rendered.Output.Trim()))"
  $png = @(Get-ChildItem -LiteralPath (Split-Path $EvidencePrefix) -Filter "$(Split-Path $EvidencePrefix -Leaf)-*.png")
  Assert-That ($png.Count -eq 1) "exactly one last-page PNG was written (got $($png.Count))"
  $ocr = Invoke-Tool tesseract @($png[0].FullName, 'stdout', '-l', 'eng', '--psm', '6')
  Assert-That ($ocr.ExitCode -eq 0) "tesseract reads $($png[0].Name)"
  Assert-That ($ocr.Output -match [regex]::Escape($Marker)) "$($png[0].Name) contains '$Marker' (got: $($ocr.Output.Trim() -replace '\s+', ' '))"
  # Keep the first page too, as evidence of what the virtual printer received.
  $first = Invoke-Tool pdftoppm @('-f', '1', '-l', '1', '-r', '96', '-png', $Path, "$EvidencePrefix-first")
  $firstPng = @(Get-ChildItem -LiteralPath (Split-Path $EvidencePrefix) -Filter "$(Split-Path $EvidencePrefix -Leaf)-first-*.png")
  Write-Host "evidence: $($firstPng[0].FullName), $($png[0].FullName) (exit $($first.ExitCode))"
}

$Xprint = (Resolve-Path -LiteralPath $Xprint).Path
$manifest = Get-Content -Raw (Join-Path $PSScriptRoot 'sumatra.json') | ConvertFrom-Json
$Sumatra = Join-Path (Split-Path $Xprint) $manifest.exe
$layoutFixture = Join-Path $PSScriptRoot '..\tests\fixtures\layout.cpp'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

Assert-That ([System.Environment]::OSVersion.Platform -eq 'Win32NT') 'running on Windows'
Assert-That ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted') `
  'refusing to change the default printer outside a GitHub-hosted CI runner'
Assert-That ((Get-Service Spooler).Status -eq 'Running') 'Print Spooler service is running'
$pdfDriver = Get-PrinterDriver -Name 'Microsoft Print to PDF' -ErrorAction SilentlyContinue
Assert-That ($null -ne $pdfDriver) 'Microsoft Print to PDF driver is installed'
Assert-That (Test-Path -LiteralPath $Xprint -PathType Leaf) "xprint exists at $Xprint"
Assert-That (Test-Path -LiteralPath $Sumatra -PathType Leaf) "SumatraPDF exists next to xprint at $Sumatra"
Assert-That (Test-Path -LiteralPath $layoutFixture -PathType Leaf) "layout fixture exists at $layoutFixture"
foreach ($tool in 'pdfinfo', 'pdftoppm', 'tesseract') {
  Assert-That ($null -ne (Get-Command $tool -ErrorAction SilentlyContinue)) "$tool is on PATH (CI prerequisite)"
}
$tesseractLanguages = Invoke-Tool tesseract @('--list-langs')
Assert-That ($tesseractLanguages.Output -match '(?m)^eng') "tesseract has the eng language pack ($($tesseractLanguages.Output.Trim() -replace '\s+', ' '))"

$sumatraHash = (Get-FileHash $Sumatra -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-That ($sumatraHash -eq $manifest.exeSha256) 'SumatraPDF SHA256 matches the pinned manifest'
$signature = Get-AuthenticodeSignature $Sumatra
Assert-That ($signature.Status -eq 'Valid') "SumatraPDF Authenticode status is $($signature.Status)"
Assert-That ($signature.SignerCertificate.Subject -match [regex]::Escape("CN=$($manifest.signer)")) "SumatraPDF signer is $($manifest.signer)"

# layout.cpp renders to 7 pages. The ASCII marker is appended only to the copy
# used here so the pixel fixture in tests/ stays untouched.
$lastLineMarker = 'XPRINT-LAST-LINE-7Z7'
$layoutDirectory = Join-Path $WorkDir 'layout'
New-Item -ItemType Directory -Force -Path $layoutDirectory | Out-Null
$layoutSource = Join-Path $layoutDirectory 'layout.cpp'
Copy-Item -LiteralPath $layoutFixture -Destination $layoutSource
Add-Content -LiteralPath $layoutSource -Encoding UTF8 -Value "// $lastLineMarker"

$token = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$defaultQueueName = "xprint-ci-$token-pdf"
$chineseQueueName = "xprint-ci-$token 中文 队列"
$outputPdf = Join-Path $WorkDir "xprint-job-$token.pdf"
$outputPdfChinese = Join-Path $WorkDir "xprint-job-$token-chinese.pdf"
$queueNamesBefore = @(Get-Printer | Select-Object -ExpandProperty Name)
$defaultBefore = Get-DefaultPrinterName
$createdQueues = New-Object System.Collections.Generic.List[string]
$createdPorts = New-Object System.Collections.Generic.List[string]
$succeeded = $false

try {
  Write-Host "default printer before: '$defaultBefore'"
  Assert-That ($queueNamesBefore -notcontains $defaultQueueName) "queue name $defaultQueueName is unused"
  Assert-That ($queueNamesBefore -notcontains $chineseQueueName) "queue name $chineseQueueName is unused"

  foreach ($queue in @(
    @{ Name = $defaultQueueName; Port = $outputPdf },
    @{ Name = $chineseQueueName; Port = $outputPdfChinese }
  )) {
    Assert-That ($null -eq (Get-PrinterPort -Name $queue.Port -ErrorAction SilentlyContinue)) "port $($queue.Port) is unused"
    Assert-That (-not (Test-Path -LiteralPath $queue.Port)) "no stale output file at $($queue.Port)"
    Add-PrinterPort -Name $queue.Port
    $createdPorts.Add($queue.Port)
    Add-Printer -DriverName 'Microsoft Print to PDF' -PortName $queue.Port -Name $queue.Name
    $createdQueues.Add($queue.Name)
  }

  $setDefault = Set-DefaultPrinter -Name $defaultQueueName
  Assert-That ($setDefault.ExitCode -eq 0) "setting $defaultQueueName as the default printer succeeded"
  Assert-That ($setDefault.Readback -eq $defaultQueueName) "default printer readback is '$defaultQueueName' (got '$($setDefault.Readback)')"

  $defaultDirectory = New-ContestDirectory -Name 'default-queue' -Printer '' -Source $layoutSource
  $defaultResult = Invoke-Xprint -Directory $defaultDirectory -Arguments @('-y', 'layout.cpp')
  Write-Host $defaultResult.Output
  Assert-That ($defaultResult.ExitCode -eq 0) "default queue submission exits 0 (got $($defaultResult.ExitCode))"
  Assert-That ($defaultResult.Output -match '已提交到') 'xprint reports that the job was submitted'
  Assert-That ($defaultResult.Output -match [regex]::Escape($defaultQueueName)) "xprint resolved the temporary queue $defaultQueueName"
  Assert-That ($defaultResult.Output -match '（黑白）') 'the default queue job is requested in monochrome'
  Wait-ForPdf $outputPdf $defaultQueueName
  Assert-PdfOutput -Path $outputPdf -ExpectedPages 7 -Marker $lastLineMarker -EvidencePrefix (Join-Path $WorkDir "evidence-$token")
  # The default job is finished. Later submissions must write their own spool
  # file and leave this one untouched.
  $defaultOutputHash = (Get-FileHash $outputPdf -Algorithm SHA256).Hash

  $missingSource = Invoke-Xprint -Directory $WorkDir -Arguments @('-y', 'missing-source.cpp')
  Assert-That ($missingSource.ExitCode -ne 0) 'a missing source file exits non-zero'

  $missingQueueDirectory = New-ContestDirectory -Name 'missing-queue' -Printer 'Missing_Queue'
  $missingQueueResult = Invoke-Xprint -Directory $missingQueueDirectory -Arguments @('-y', 'A.cpp')
  Write-Host $missingQueueResult.Output
  Assert-That ($missingQueueResult.ExitCode -ne 0) 'a configured queue that does not exist exits non-zero'
  Assert-That ($missingQueueResult.Output -match 'Missing_Queue') 'the missing queue name is reported'
  Assert-That ($missingQueueResult.Output -match 'Print Spooler|不存在') 'the missing queue error is actionable'
  Assert-That (-not (Test-Path -LiteralPath $outputPdfChinese)) 'no job reached the virtual printer for the missing queue case'

  # A problem subdirectory inherits both settings from the nearest contest file.
  $chineseRoot = New-ContestDirectory -Name 'chinese-queue' -Printer $chineseQueueName
  $chineseQuestion = Join-Path $chineseRoot 'question-1'
  New-Item -ItemType Directory -Force -Path $chineseQuestion | Out-Null
  Copy-Item -LiteralPath $layoutSource -Destination (Join-Path $chineseQuestion 'layout.cpp')
  Add-Content -LiteralPath (Join-Path $chineseRoot '.xprint.yaml') -Encoding UTF8 -Value 'color: color'
  $chineseResult = Invoke-Xprint -Directory $chineseQuestion -Arguments @('-y', 'layout.cpp')
  Write-Host $chineseResult.Output
  Assert-That ($chineseResult.ExitCode -eq 0) "Chinese queue submission exits 0 (got $($chineseResult.ExitCode))"
  Assert-That ($chineseResult.Output -match '已提交到') 'the Chinese queue submission reports success'
  Assert-That ($chineseResult.Output -match [regex]::Escape($chineseQueueName)) "the receipt names the Chinese queue $chineseQueueName"
  Assert-That ($chineseResult.Output -match '（彩色）') 'the inherited contest config requests color'
  Wait-ForPdf $outputPdfChinese $chineseQueueName
  Assert-PdfOutput -Path $outputPdfChinese -ExpectedPages 7 -Marker $lastLineMarker -EvidencePrefix (Join-Path $WorkDir "evidence-$token-chinese")
  Assert-That ((Get-FileHash $outputPdf -Algorithm SHA256).Hash -eq $defaultOutputHash) 'the default queue spool file is unchanged after the Chinese queue job'

  Write-Host ''
  Write-Host 'ACCEPTANCE PASSED'
  Write-Host "  default queue: $defaultQueueName -> $outputPdf"
  Write-Host "  chinese queue: $chineseQueueName -> $outputPdfChinese"
  $succeeded = $true
} finally {
  # Restore the default first. If that fails the temporary queue is kept,
  # because deleting a default printer makes Windows pick another one silently.
  # Every step here is guarded: a failure while cleaning up must neither hide
  # the original error nor stop the remaining queues and ports from being removed.
  $cleanupErrors = New-Object System.Collections.Generic.List[string]
  try {
    $currentDefault = Get-DefaultPrinterName -Optional
    if ($currentDefault -eq $defaultQueueName) {
      if ($defaultBefore) {
        $restore = Set-DefaultPrinter -Name $defaultBefore
        if ($restore.ExitCode -eq 0 -and $restore.Readback -eq $defaultBefore) {
          Write-Host "ok - default printer restored to '$defaultBefore'"
        } else {
          Write-Warning "could not restore the default printer to '$defaultBefore'; keeping $defaultQueueName"
          $cleanupErrors.Add("default printer could not be restored to '$defaultBefore'")
          $createdQueues.Remove($defaultQueueName) | Out-Null
          $createdPorts.Remove($outputPdf) | Out-Null
        }
      } else {
        # There was no default before the run. Removing the only default printer
        # makes Windows choose one silently, so keep ours and only warn.
        Write-Warning "no default printer existed before the run; keeping $defaultQueueName as the default"
        $createdQueues.Remove($defaultQueueName) | Out-Null
        $createdPorts.Remove($outputPdf) | Out-Null
      }
    }
  } catch { $cleanupErrors.Add("restoring the default printer failed: $($_.Exception.Message)") }
  foreach ($name in $createdQueues) {
    try {
      # These randomly named queues were created by this invocation.
      Get-PrintJob -PrinterName $name -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue
      Remove-Printer -Name $name -ErrorAction Stop
      $deadline = (Get-Date).AddSeconds(20)
      while ((Get-Printer -Name $name -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
      }
      Assert-That ($null -eq (Get-Printer -Name $name -ErrorAction SilentlyContinue)) "temporary queue $name removed"
    } catch { $cleanupErrors.Add($_.Exception.Message) }
  }
  foreach ($port in $createdPorts) {
    try {
      Remove-PrinterPort -Name $port -ErrorAction Stop
      Assert-That ($null -eq (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) "temporary port $port removed"
    } catch { $cleanupErrors.Add($_.Exception.Message) }
  }
  if ($defaultBefore) {
    try {
      Assert-That ((Get-DefaultPrinterName -Optional) -eq $defaultBefore) "the default printer is '$defaultBefore' after cleanup"
    } catch { $cleanupErrors.Add($_.Exception.Message) }
  }
  try {
    $queueNamesAfter = @(Get-Printer -ErrorAction Stop | Select-Object -ExpandProperty Name)
    $missing = @($queueNamesBefore | Where-Object { $_ -notin $queueNamesAfter })
    Assert-That ($missing.Count -eq 0) "every queue that existed before the run still exists ($($missing -join ', '))"
  } catch { $cleanupErrors.Add($_.Exception.Message) }
  if ($cleanupErrors.Count -gt 0) {
    $details = $cleanupErrors -join '; '
    if ($succeeded) { throw "CLEANUP FAILED: $details" }
    # The try block already failed; keep that original error visible and only
    # report the cleanup problems alongside it.
    Write-Warning "cleanup also reported problems: $details"
  }
}
