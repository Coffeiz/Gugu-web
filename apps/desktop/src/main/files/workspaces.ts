import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { DesktopFileDirectory } from '@gugu/core/desktop'
import { DesktopError } from '../core-host.js'

type Binding = { id: DesktopFileDirectory; name: string; root: string }
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

export function fileWorkspaces(root: string, registry?: string, protectedRoot?: string) {
  const personal: Binding = { id: 'personal', name: '个人文件', root: join(root, 'personal') }
  let pending: Promise<unknown> = Promise.resolve()

  async function load(): Promise<Binding[]> {
    if (!registry) return []
    const json = await readFile(registry, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '[]'
      throw error
    })
    const rows = JSON.parse(json) as Binding[]
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.name !== 'string'
      || typeof row.root !== 'string' || !isAbsolute(row.root) || (row.id !== 'personal' && !bindingId.test(row.id))))
      throw new DesktopError('invalid_request', '工作区登记文件无效')
    return rows
  }

  async function save(rows: Binding[]) {
    if (!registry) throw new DesktopError('unsupported', '当前环境不支持绑定系统目录')
    await mkdir(dirname(registry), { recursive: true })
    const temp = registry + '.' + randomUUID()
    try {
      await writeFile(temp, JSON.stringify(rows), { flag: 'wx', mode: 0o600 })
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

  async function resolveRoot(binding: Binding) {
    if (binding === personal) return (await managedRoots()).personal
    const actual = await directory(binding.root)
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
    async get(id: unknown) {
      const rows = await load()
      return id === undefined || id === 'personal' ? currentPersonal(rows) : find(rows, id)
    },
    resolveRoot,
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
        const row = id === undefined
          ? { id: `desktop:${randomUUID()}` as const, name: basename(actual), root: actual }
          : id === 'personal' ? { ...defaultBinding, root: actual } : find(rows, id)
        row.root = actual
        if (id === 'personal') rows = rows.filter(item => item.id !== 'personal')
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
        await save(rows.filter(item => item !== row))
      })
    },
  }
}
