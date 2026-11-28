import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { relative, sep, win32 } from 'node:path'

const execute = promisify(execFile)
const remoteMacTypes = /^(?:smbfs|nfs|afpfs|webdav|fuse|macfuse|osxfuse|sshfs|ftpfs)/iu
const remotePaths = new Map<string, { expires: number; result: Promise<boolean> }>()

function inside(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith('..' + sep))
}

async function remoteMacFilesystem(path: string) {
  const { stdout } = await execute('/sbin/mount', [], { timeout: 1500 })
  return stdout.split('\n').some(line => {
    const match = /^.+ on (.+) \(([^,)]+)/u.exec(line)
    if (!match || !remoteMacTypes.test(match[2]!)) return false
    const mountPath = match[1]!.replaceAll('\\040', ' ')
    return inside(mountPath, path)
  })
}

async function remoteWindowsFilesystem(path: string) {
  const root = win32.parse(path).root
  if (!root) return false
  if (root.startsWith('\\\\')) return true
  const ffi = await import('node:ffi')
  const getDriveType = ffi.dlopen('kernel32.dll', {
    GetDriveTypeW: { arguments: ['pointer'], return: 'u32' },
  }).functions.GetDriveTypeW as (path: Buffer) => number
  return getDriveType(Buffer.from(root + '\0', 'utf16le')) === 4
}

/** 判断工作区是否位于网络或用户态挂载文件系统。 */
export async function isRemoteFilesystem(path: string) {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return false
  const cached = remotePaths.get(path)
  if (cached && cached.expires > Date.now()) return cached.result
  const result = (process.platform === 'darwin' ? remoteMacFilesystem(path) : remoteWindowsFilesystem(path))
    .catch(() => true)
  remotePaths.set(path, { expires: Date.now() + 10_000, result })
  return result
}
