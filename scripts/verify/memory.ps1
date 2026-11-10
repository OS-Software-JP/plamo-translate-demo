param([string]$ProcessIds)
$ids = @($ProcessIds.Split(',') | ForEach-Object { [int]$_ })
$samples = (Get-Counter '\GPU Process Memory(*)\Dedicated Usage','\GPU Process Memory(*)\Shared Usage' -ErrorAction SilentlyContinue).CounterSamples
$total = 0.0
foreach ($sample in $samples) {
  if ($sample.Path -match 'pid_(\d+)_' -and $ids -contains [int]$Matches[1]) { $total += $sample.CookedValue }
}
@{gpu=$total} | ConvertTo-Json -Compress
