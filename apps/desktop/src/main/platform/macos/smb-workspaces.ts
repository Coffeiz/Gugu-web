import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)

export function smbShareUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'smb:' || !url.hostname || !/^\/[^/]+\/?$/u.test(url.pathname)
      || url.search || url.hash) return
    url.username = ''
    url.password = ''
    return url.href
  } catch {
    return
  }
}

export async function listSmbMounts() {
  if (process.platform !== 'darwin') return []
  const { stdout } = await execute('/sbin/mount', ['-t', 'smbfs'], { timeout: 1500 })
  return stdout.split('\n').flatMap(line => {
    const match = /^(\/\/.*) on (\/.*) \(smbfs(?:,|\))/u.exec(line)
    if (!match) return []
    const url = smbShareUrl('smb:' + match[1])
    return url ? [{ url, path: match[2]! }] : []
  })
}

export const smbWorkspaces = {
  mounts: listSmbMounts,
  async connect(url: string) {
    await execute('/usr/bin/open', ['-g', url], { timeout: 1500 })
  },
  delay,
}
