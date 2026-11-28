import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'
let oemEncoding: string | undefined

/** 无控制台的隔离进程可能无法切换代码页；按系统 OEM 代码页解释原始字节。 */
export function decodeWindowsOutput(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* 原生命令可能使用系统 OEM 编码。 */ }
  if (!oemEncoding) {
    const system = process.env.SystemRoot ?? 'C:\\Windows'
    const result = execFileSync(win32.join(system, 'System32', 'reg.exe'), ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], { windowsHide: true, timeout: 3000, encoding: 'utf8' })
    const code = result.match(/OEMCP\s+REG_SZ\s+(\d+)/)?.[1]
    const encodings: Record<string, string> = { '936': 'gb18030', '950': 'big5', '932': 'shift_jis', '949': 'euc-kr', '1252': 'windows-1252', '65001': 'utf-8', '866': 'ibm866' }
    oemEncoding = code ? encodings[code] : undefined
    if (!oemEncoding) throw new Error('无法解码原生命令输出：不支持的 Windows OEM 代码页')
  }
  return new TextDecoder(oemEncoding).decode(bytes)
}
