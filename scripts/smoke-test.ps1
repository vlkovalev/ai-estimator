$ErrorActionPreference = 'Stop'

# Simple smoke test: POST two CSVs from uploads folder to local server
$cost = "uploads/1778955359821-265833530-costcodes.csv - Sheet1 (1).csv"
$sample = "uploads/1778955359823-919025711-Estimate CSV - Sheet1.csv"

if (-not (Test-Path $cost)) { Write-Error "Cost file not found: $cost" }
if (-not (Test-Path $sample)) { Write-Error "Sample file not found: $sample" }

Write-Host "Posting to http://localhost:3000/api/estimate ..."

$resp = curl.exe -s -F "costCodes=@$cost" -F "sampleEstimate=@$sample" http://localhost:3000/api/estimate
Write-Host "Response:`n$resp"
