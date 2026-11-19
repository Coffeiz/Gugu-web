import type { Pool } from 'pg'
import type { Kysely } from 'kysely'
import { createDefaultWorkspaceShellTargetReader, createWorkspaceShellDirectoryReader, createWorkspaceShellTargetReader } from '@gugu/core/workspaces/shell-target'
import { readPostgresFolderPathMirrorKey, readPostgresProjectPathMirrorKey } from '../files/folder-path-planner.js'
import { prepareTerminalMounts } from './mounts.js'

/** 挂载来源来自 owner 限定的数据查询，不接受 HTTP 路径作为授权事实。 */
export function createTerminalWorkspaceMounts<DB>(pool: Pick<Pool, 'connect'>, db: Kysely<DB>, storageRoot: string) {
  const target = createWorkspaceShellTargetReader(db, 'postgres')
  const defaultTarget = createDefaultWorkspaceShellTargetReader(db, 'postgres')
  const directories = createWorkspaceShellDirectoryReader(db, 'postgres')
  return async (owner: string, workspaceId: number | null, fullUserSandboxWrite: boolean, cwd: string) => {
    const selected = workspaceId === null ? await defaultTarget(owner) : await target(owner, workspaceId)
    if (!selected) throw new Error('当前工作区挂载无法安全解析')
    const client = await pool.connect()
    let primary: string
    try {
      if (selected.kind === 'directory') {
        if (!/^[A-Za-z0-9_-]+$/.test(selected.directoryName)) throw new Error('工作区目录无效')
        primary = `${owner}/workspace/${selected.directoryName}`
      } else if (selected.kind === 'folder') primary = await readPostgresFolderPathMirrorKey(client, owner, selected.folderId)
      else primary = await readPostgresProjectPathMirrorKey(client, owner, selected.projectId)
    } finally { client.release() }
    const writable = [primary]
    const libraryRoots = [`${owner}/个人文件`, `${owner}/项目文件`]
    // 老账号尚未使用文件库时，声明可能早于实际目录。只补固定根，不重建已丢失的普通目录。
    const initialize = new Set([...libraryRoots, `${owner}/workspace/default`])
    const readonly = fullUserSandboxWrite ? [] : libraryRoots
    if (fullUserSandboxWrite) writable.push(...libraryRoots)
    if (fullUserSandboxWrite) for (const directory of await directories(owner)) {
      if (!/^[A-Za-z0-9_-]+$/.test(directory.directoryName)) throw new Error('工作区目录无效')
      writable.push(`${owner}/workspace/${directory.directoryName}`)
    }
    return prepareTerminalMounts(storageRoot, owner, primary, readonly, [...new Set(writable)], cwd, initialize)
  }
}
