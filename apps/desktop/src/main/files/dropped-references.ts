import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { desktopKeyFile } from '../../../../../packages/core/src/shared/desktop-key-file.js'
import { DesktopError } from '../core-host.js'

const prefix = 'drop-'
const identity = (info: { dev: bigint; ino: bigint; birthtimeNs: bigint }) => [info.dev, info.ino, info.birthtimeNs].join('.')

/** 只签发给系统拖入或已经授权的宿主机路径，引用不含明文主机路径。 */
export function createDroppedFileReferences(directory: string, openFile: (path: string) => Promise<string>) {
  const key = desktopKeyFile(join(directory, 'dropped-file-reference.key'), '本机文件引用密钥无效')
  async function locate(id: unknown, allowFolder = false) {
    if (typeof id !== 'string' || !/^drop-[A-Za-z0-9_-]{1,24000}$/u.test(id)) return null
    try {
      const sealed = Buffer.from(id.slice(prefix.length), 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', await key.read(), sealed.subarray(0, 12))
      decipher.setAuthTag(sealed.subarray(12, 28))
      const { path, fileIdentity, type } = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8')) as {
        path: string; fileIdentity: string; type?: 'folder'
      }
      if (!isAbsolute(path) || await realpath(path) !== path) return null
      const info = await lstat(path, { bigint: true })
      if (identity(info) !== fileIdentity) return null
      if (type === 'folder') return allowFolder && info.isDirectory() ? { path, fileIdentity, type } : null
      return info.isFile() ? { path, fileIdentity } : null
    } catch { return null }
  }
  return {
    async create(path: unknown, expectedIdentity?: string, allowFolder = false) {
      if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path))
        throw new DesktopError('invalid_request', '请从系统文件管理器拖入文件')
      const resolved = await realpath(path)
      const info = await lstat(resolved, { bigint: true })
      const type: 'file' | 'folder' = allowFolder && info.isDirectory() ? 'folder' : 'file'
      if (type === 'file' && !info.isFile()) throw new DesktopError('invalid_request', '请选择普通文件')
      if (expectedIdentity !== undefined && (resolved !== path || identity(info) !== expectedIdentity))
        throw new DesktopError('not_found', '本机文件已移动或替换')
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', await key.readOrCreate(), nonce)
      const encrypted = Buffer.concat([cipher.update(JSON.stringify({ path: resolved, fileIdentity: identity(info), type: type === 'folder' ? type : undefined })), cipher.final()])
      const id = prefix + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')
      return { type, id, label: Array.from(basename(resolved)).slice(0, 255).join('') }
    },
    resolve: locate,
    async open(id: unknown) {
      const file = await locate(id, true)
      if (!file) throw new DesktopError('not_found', '文件已移动或无法访问')
      if (await openFile(file.path)) throw new DesktopError('unsupported', '系统无法打开此文件')
      return null
    },
  }
}
