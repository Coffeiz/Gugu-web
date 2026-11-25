param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$directory = $PSScriptRoot
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
    $current = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $entries = @($current -split ';' | Where-Object { $_ })
    if ($Remove) {
        if (!(Test-Path -LiteralPath (Join-Path $directory '.gugu-path'))) { exit 0 }
        $entries = @($entries | Where-Object { $_ -ine $directory })
    } else {
        if ($entries -icontains $directory) { exit 0 }
        New-Item -ItemType File -Path (Join-Path $directory '.gugu-path') -Force | Out-Null
        $entries += $directory
    }
    $key.SetValue('Path', ($entries -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
} finally {
    $key.Dispose()
}
