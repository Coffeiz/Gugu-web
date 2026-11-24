import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { DesktopFileDirectory } from '@gugu/core/desktop'
import { smbShareUrl, smbWorkspaces } from './smb-workspaces.js'
import { DesktopError } from '../core-host.js'

type Binding = { id: DesktopFileDirectory; name: string; root: string; projectIds?: number[]; activeProjectIds?: number[]; commandNumber?: number; smb?: { url: string; mountPath: string } }
const bindingId = /^desktop:[a-f0-9-]{36}$/

function contains(parent: string, child: string) {
  const path = relative(parent, child)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}

async function directory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new DesktopError('forbidden', '文件工作区无效')
  return realpath(path)
}

export function fileWorkspaces(root: string, registry?: string, protectedRoot?: string, smb = smbWorkspaces) {
  const personal: Binding = { id: 'personal', name: '个人文件', root: join(root, 'personal') }
  let pending: Promise<unknown> = Promise.resolve()
  const reconnecting = new Map<string, Promise<boolean>>()
  const nextNumbers = new WeakMap<Binding[], number>()

  async function load(): Promise<Binding[]> {
    if (!registry) return []
    const json = await readFile(registry, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '[]'
      throw error
    })
    const stored = JSON.parse(json) as Binding[] | { rows: Binding[]; nextCommandNumber: number }
    const rows = Array.isArray(stored) ? stored : stored?.rows
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.name !== 'string'
      || (row.projectIds !== undefined && (!Array.isArray(row.projectIds) || row.projectIds.some(id => !Number.isSafeInteger(id) || id < 1)))
      || (row.activeProjectIds !== undefined && (!Array.isArray(row.activeProjectIds)
        || row.activeProjectIds.some(id => row.id === 'personal' || !row.projectIds?.includes(id))))
      || typeof row.root !== 'string' || !isAbsolute(row.root)
      || (row.smb !== undefined && (!row.smb || typeof row.smb.url !== 'string' || smbShareUrl(row.smb.url) !== row.smb.url
        || typeof row.smb.mountPath !== 'string' || !row.smb.mountPath.startsWith('/Volumes/') || !contains(row.smb.mountPath, row.root))) || (row.id !== 'personal' && !bindingId.test(row.id))))
      throw new DesktopError('invalid_request', '工作区登记文件无效')
    const assigned = rows.flatMap(row => row.commandNumber === undefined ? [] : [row.commandNumber])
    const next = Array.isArray(stored) ? 1 : stored.nextCommandNumber
    if (!Number.isSafeInteger(next) || next < 1 || new Set(assigned).size !== assigned.length
      || assigned.some(number => !Number.isSafeInteger(number) || number < 1 || number >= next))
      throw new DesktopError('invalid_request', '工作区数字编号无效')
    nextNumbers.set(rows, next)
    return rows
  }

  async function save(rows: Binding[]) {
    if (!registry) throw new DesktopError('unsupported', '当前环境不支持绑定系统目录')
    let nextCommandNumber = nextNumbers.get(rows) ?? 1
    for (const row of rows)
      if (row.id !== 'personal' && row.commandNumber === undefined) row.commandNumber = nextCommandNumber++
    nextNumbers.set(rows, nextCommandNumber)
    await mkdir(dirname(registry), { recursive: true })
    const temp = registry + '.' + randomUUID()
    try {
      await writeFile(temp, JSON.stringify({ rows, nextCommandNumber }), { flag: 'wx', mode: 0o600 })
      await rename(temp, registry)
    } finally {
      await rm(temp, { force: true })
    }
  }

  function change<T>(operation: (rows: Binding[]) => Promise<T>): Promise<T> {
    const result = pending.then(async () => operation(await load()))
    pending = result.then(() => undefined, () => undefined)
    return result
  }

  function find(rows: Binding[], id: unknown) {
    const row = rows.find(row => row.id === id)
    if (!row) throw new DesktopError('not_found', '工作区不存在，请重新选择')
    return row
  }

  async function managedRoots() {
    await mkdir(root, { recursive: true })
    const base = await directory(root)
    const personalRoot = join(base, 'personal')
    const projectRoot = join(base, 'project')
    await Promise.all([mkdir(personalRoot, { recursive: true }), mkdir(projectRoot, { recursive: true })])
    return { base, personal: await directory(personalRoot), project: await directory(projectRoot) }
  }

  async function mountedShares() {
    // 系统命令的原始输出可能含用户名，只在本机解析。
    try { return await smb.mounts() }
    catch { throw new DesktopError('workspace_unavailable', '无法检查工作区连接') }
  }

  async function discoverShare(path: string) {
    if (!path.startsWith('/Volumes/')) return
    const mount = (await mountedShares()).find(item => contains(item.path, path))
    if (mount) return { url: mount.url, mountPath: mount.path }
  }

  async function reconnect(share: NonNullable<Binding['smb']>) {
    const key = JSON.stringify(share)
    const current = reconnecting.get(key)
    if (current) return current
    const attempt = (async () => {
      for (const wait of [500, 1000, 1800]) {
        const mounts = await mountedShares()
        if (mounts.some(mount => mount.path === share.mountPath))
          return mounts.some(mount => mount.path === share.mountPath && mount.url === share.url)
        if (mounts.some(mount => mount.url === share.url)) return false
        // Finder 负责认证；传入的地址只含服务器和共享名。
        await smb.connect(share.url).catch(() => undefined)
        await smb.delay(wait)
      }
      return (await mountedShares()).some(mount => mount.path === share.mountPath && mount.url === share.url)
    })()
    reconnecting.set(key, attempt)
    try { return await attempt }
    finally { reconnecting.delete(key) }
  }

  async function resolveRoot(binding: Binding) {
    if (binding === personal) return (await managedRoots()).personal
    const share = binding.smb
    if (share && !(await mountedShares()).some(mount => mount.path === share.mountPath && mount.url === share.url))
      throw new DesktopError('workspace_unavailable', '工作区已断开')
    let actual: string
    try { actual = await directory(binding.root) }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ENOTCONN', 'EHOSTDOWN', 'ESTALE', 'ETIMEDOUT'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new DesktopError('workspace_unavailable', '工作区目录不可用')
      throw error
    }
    if (relative(binding.root, actual) !== '')
      throw new DesktopError('forbidden', '工作区位置已变化，请重新定位')
    return actual
  }

  function currentPersonal(rows: Binding[]) {
    const binding = rows.find(row => row.id === 'personal')
    return !binding || relative(root, binding.root) === '' ? personal : binding
  }

  return {
    async list() {
      await managedRoots()
      const rows = await load()
      return [currentPersonal(rows), ...rows.filter(row => row.id !== 'personal')].map(({ id, name }) => ({ id, name }))
    },
    async isBoundToProject(projectId: number, id: unknown) {
      return typeof id === 'string' && bindingId.test(id)
        && (await load()).some(row => row.id === id && row.projectIds?.includes(projectId))
    },
    async listDirectories(projectId?: number, boundOnly = false) {
      const all = await change(async rows => {
        if (rows.some(row => row.id !== 'personal' && row.commandNumber === undefined)) await save(rows)
        return rows
      })
      const rows = all.filter(row => row.id !== 'personal' && (!boundOnly || (projectId !== undefined && row.projectIds?.includes(projectId))))
      return Promise.all(rows.map(async row => {
        const path = await resolveRoot(row).catch(error => {
          if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'forbidden', 'workspace_unavailable'].includes(error.code)) return null
          throw error
        })
        return { id: row.id, name: row.name, commandNumber: row.commandNumber, bound: projectId !== undefined && (row.projectIds?.includes(projectId) ?? false), active: projectId !== undefined && (row.activeProjectIds?.includes(projectId) ?? false), path }
      }))
    },
    async activeProjectDirectory(projectId: number) {
      return (await load()).find(row => row.activeProjectIds?.includes(projectId))?.id ?? `project:${projectId}` as const
    },
    setProjectBinding(projectId: number, id: unknown, bound: boolean, authorize: () => Promise<unknown>) {
      return change(async rows => {
        await authorize()
        const projectRoot = bound && id === `project:${projectId}`
        if (!projectRoot && (typeof id !== 'string' || !bindingId.test(id)))
          throw new DesktopError('invalid_request', '请选择已登记的工作区')
        const selected = projectRoot ? undefined : find(rows, id)
        const current = rows.find(row => row.activeProjectIds?.includes(projectId))

        if (bound) {
          if (selected === current) return false
          if (selected) {
            await resolveRoot(selected)
            selected.projectIds = [...new Set([...(selected.projectIds ?? []), projectId])]
            selected.activeProjectIds = [...(selected.activeProjectIds ?? []), projectId]
          }
          if (current) current.activeProjectIds = current.activeProjectIds?.filter(id => id !== projectId)
        } else {
          if (!selected?.projectIds?.includes(projectId)) return false
          selected.projectIds = selected.projectIds.filter(id => id !== projectId)
          if (current === selected) selected.activeProjectIds = selected.activeProjectIds?.filter(id => id !== projectId)
        }
        await save(rows)
        return true
      })
    },
    async get(id: unknown) {
      const rows = await load()
      return id === undefined || id === 'personal' ? currentPersonal(rows) : find(rows, id)
    },
    resolveRoot,
    async prepareBrowse(binding: Binding) {
      const share = binding.smb ?? await discoverShare(binding.root)
      if (!share) return
      if (!binding.smb) {
        await change(async rows => {
          const current = rows.find(row => row.id === binding.id && row.root === binding.root)
          if (current && !current.smb) {
            current.smb = share
            await save(rows)
          }
        })
        binding.smb = share
      }
      if (!await reconnect(share)) throw new DesktopError('workspace_unavailable', '工作区已断开，重连未成功')
    },
    managedRoots,
    bind(path: string, id?: unknown) {
      return change(async rows => {
        const actual = await directory(path)
        const appData = protectedRoot ? await realpath(protectedRoot) : undefined
        if (appData && (contains(actual, appData) || contains(appData, actual)))
          throw new DesktopError('forbidden', '请选择与应用数据分开的目录')

        const defaultBinding = currentPersonal(rows)
        const managed = await managedRoots()
        if (contains(actual, managed.base) || contains(managed.project, actual)
          || (relative(managed.personal, actual) !== '' && (contains(managed.personal, actual) || contains(actual, managed.personal))))
          throw new DesktopError('conflict', '所选目录与咕咕管理的目录重叠')
        const defaultRoot = defaultBinding === personal ? managed.personal : defaultBinding.root
        const bindings = [{ ...defaultBinding, root: defaultRoot }, ...rows.filter(row => row.id !== 'personal')]
        const existing = bindings.find(row => relative(row.root, actual) === '')
        if (id === undefined && existing) return existing.id
        if (bindings.some(row => row.id !== id && (contains(row.root, actual) || contains(actual, row.root))))
          throw new DesktopError('conflict', '所选目录与已绑定的工作区重叠')
        const row: Binding = id === undefined
          ? { id: `desktop:${randomUUID()}`, name: basename(actual), root: actual }
          : id === 'personal' ? { ...defaultBinding, root: actual } : find(rows, id)
        row.root = actual
        const share = await discoverShare(actual)
        if (share) row.smb = share
        else delete row.smb
        if (id === 'personal') {
          const index = rows.findIndex(item => item.id === 'personal')
          if (index >= 0) rows.splice(index, 1)
        }
        if (id === undefined || id === 'personal') rows.push(row)
        await save(rows)
        return row.id
      })
    },
    rename(id: unknown, name: unknown) {
      return change(async rows => {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 100)
          throw new DesktopError('invalid_request', '工作区名称无效')
        if (id === 'personal') throw new DesktopError('forbidden', '个人文件名称固定')
        find(rows, id).name = name.trim()
        await save(rows)
      })
    },
    remove(id: unknown) {
      return change(async rows => {
        if (id === 'personal') throw new DesktopError('forbidden', '个人文件不可解除绑定')
        const row = find(rows, id)
        rows.splice(rows.indexOf(row), 1)
        await save(rows)
      })
    },
  }
}
