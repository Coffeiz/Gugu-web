import { win32 } from 'node:path'
import { createMxcExecutor, mxcDiagnostics } from '../mxc/platform.js'

export function windowsPowerShell(command: string) {
  const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const prelude = `$ProgressPreference = 'SilentlyContinue'; [Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = New-Object System.Text.UTF8Encoding; & "$env:SystemRoot\\System32\\chcp.com" 65001 > $null; `
  const script = prelude + command + '\nif (-not $?) { exit 1 }; if ($LASTEXITCODE) { exit $LASTEXITCODE }'
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return { executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; & ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + encoded + "'))))"] }
}

export const windowsShell = {
  id: 'mxc-processcontainer-offline-v1',
  method: 'processcontainer',
  diagnostics: mxcDiagnostics,
  createExecutor: createMxcExecutor,
  command(command: string) {
    const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    return `"${executable}" /d /s /c "chcp 65001 >nul & ${command}"`
  },
}
