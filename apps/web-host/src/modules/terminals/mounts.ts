import { pinTerminalDirectory } from './pinned-directory.js'

function sandboxTarget(key: string): string {
  const [, space, ...tail] = key.split('/')
  const target = space === '项目文件' ? 'project' : space === '个人文件' ? 'personal' : space === 'workspace' ? 'workspace' : null
  if (!target) throw new Error('工作区来源不属于可挂载的文件空间')
  return '/' + [target, ...tail].join('/')
}

/** 输入 key 必须由 owner 限定的数据库查询产生；不接收客户端提供的挂载列表。 */
export async function prepareTerminalMounts(root: string, owner: string, primaryKey: string, readonlyKeys: readonly string[], writableKeys: readonly string[], cwd: string, initializeKeys: ReadonlySet<string> = new Set()) {
  if (!writableKeys.includes(primaryKey)) throw new Error('终端工作区未授权')
  const keys = [...new Set([...readonlyKeys, ...writableKeys])]
  if (keys.length > 64) throw new Error('终端挂载数量超限')
  const targets = new Map(keys.map(key => [key, sandboxTarget(key)]))
  const absolute = cwd.startsWith('/')
  const base = absolute
    ? keys.filter(key => cwd === targets.get(key) || cwd.startsWith(`${targets.get(key)}/`))
      .sort((a, b) => targets.get(b)!.length - targets.get(a)!.length)[0]
    : primaryKey
  if (!base) throw new Error('终端工作目录未授权')
  const target = targets.get(base)!
  const tail = absolute ? cwd.slice(target.length).replace(/^\//, '') : cwd
  const segments = (tail === '.' && !absolute) || tail === '' ? [] : tail.split('/')
  if (segments.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
    throw new Error('终端工作目录无效')
  const pinned: Array<Awaited<ReturnType<typeof pinTerminalDirectory>>> = []
  try {
    const paths = new Map<string, string>()
    const descriptors = new Map<string, number>()
    for (const key of keys) {
      const item = await pinTerminalDirectory(root, owner, key, initializeKeys.has(key))
      pinned.push(item); paths.set(key, item.path)
      descriptors.set(key, item.fd)
    }
    const directory = await pinTerminalDirectory(root, owner, [base, ...segments].join('/'))
    pinned.push(directory)
    return {
      sandboxCwd: [target, ...segments].join('/'),
      sandboxMounts: keys.map(key => ({ source: paths.get(key)!, descriptor: descriptors.get(key)!,
        target: targets.get(key)!, readonly: !writableKeys.includes(key) })),
      cwd: directory.path, readonlyPaths: readonlyKeys.filter(key => !writableKeys.includes(key)).map(key => paths.get(key)!),
      readwritePaths: writableKeys.map(key => paths.get(key)!), environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      async close() { for (const item of pinned.reverse()) await item.close() } }
  } catch (error) {
    for (const item of pinned.reverse()) await item.close().catch(() => {})
    throw error
  }
}
