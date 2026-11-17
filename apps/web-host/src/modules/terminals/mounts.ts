import { pinTerminalDirectory } from './pinned-directory.js'

/** 输入 key 必须由 owner 限定的数据库查询产生；不接收客户端提供的挂载列表。 */
export async function prepareTerminalMounts(root: string, owner: string, primaryKey: string, readonlyKeys: readonly string[], writableKeys: readonly string[], cwd: string) {
  const segments = cwd === '.' || cwd === '' ? [] : cwd.split('/')
  if (segments.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')) || cwd.startsWith('/'))
    throw new Error('终端工作目录无效')
  if (!writableKeys.includes(primaryKey)) throw new Error('终端工作区未授权')
  const keys = [...new Set([...readonlyKeys, ...writableKeys])]
  if (keys.length > 64) throw new Error('终端挂载数量超限')
  const pinned: Array<{ path: string; close(): Promise<void> }> = []
  try {
    const paths = new Map<string, string>()
    for (const key of keys) {
      const item = await pinTerminalDirectory(root, owner, key)
      pinned.push(item); paths.set(key, item.path)
    }
    const directory = await pinTerminalDirectory(root, owner, [primaryKey, ...segments].join('/'))
    pinned.push(directory)
    return { cwd: directory.path, readonlyPaths: readonlyKeys.filter(key => !writableKeys.includes(key)).map(key => paths.get(key)!),
      readwritePaths: writableKeys.map(key => paths.get(key)!), environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      async close() { for (const item of pinned.reverse()) await item.close() } }
  } catch (error) {
    for (const item of pinned.reverse()) await item.close().catch(() => {})
    throw error
  }
}
