import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'

/** 返回业务目标标识；宿主文件路径必须由 Host 单独安全解析。 */
export function createWorkspaceShellTargetReader<DB>(db: Kysely<DB>, dialect: 'postgres' | 'sqlite') {
  return async (rawOwner: string, workspaceId: number) => {
    const canonical = dataContext(rawOwner).ownerId
    const owner = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const workspace = (await sql<{ id: number; name: string; kind: string; folder_id: number | null; project_id: number | null; directory_id: number | null; enabled: boolean | number }>`SELECT id,name,kind,folder_id,project_id,directory_id,enabled FROM workspaces WHERE id=${workspaceId} AND user_id=${owner}`.execute(db)).rows[0]
    if (!workspace?.enabled) return null
    const base = { workspaceId: Number(workspace.id), workspaceName: workspace.name }
    if (workspace.kind === 'directory' && workspace.directory_id !== null) {
      const directory = (await sql<{ id: number; directory_name: string }>`SELECT id,directory_name FROM workspace_directories WHERE id=${workspace.directory_id} AND user_id=${owner} AND deleted_at IS NULL`.execute(db)).rows[0]
      return directory ? { ...base, kind: 'directory' as const, space: 'workspace' as const, directoryId: Number(directory.id), directoryName: directory.directory_name } : null
    }
    if (workspace.kind === 'project' && workspace.project_id !== null) {
      const project = (await sql<{ id: number; name: string }>`SELECT id,name FROM projects WHERE id=${workspace.project_id} AND user_id=${owner}`.execute(db)).rows[0]
      return project ? { ...base, kind: 'project' as const, space: 'project' as const, projectId: Number(project.id), projectName: project.name, folderId: null } : null
    }
    if (workspace.kind === 'folder' && workspace.folder_id !== null) {
      const folder = (await sql<{ id: number; name: string; project_id: number | null }>`SELECT id,name,project_id FROM folders WHERE id=${workspace.folder_id} AND user_id=${owner} AND deleted_at IS NULL`.execute(db)).rows[0]
      if (!folder) return null
      if (folder.project_id === null) return { ...base, kind: 'folder' as const, space: 'personal' as const, folderId: Number(folder.id), folderName: folder.name, projectId: null }
      const project = (await sql<{ id: number; name: string }>`SELECT id,name FROM projects WHERE id=${folder.project_id} AND user_id=${owner}`.execute(db)).rows[0]
      return project ? { ...base, kind: 'folder' as const, space: 'project' as const, folderId: Number(folder.id), folderName: folder.name, projectId: Number(project.id), projectName: project.name } : null
    }
    return null
  }
}

/** 未绑定工作区时使用用户默认目录，不修改会话绑定或授予完整用户沙箱权限。 */
export function createDefaultWorkspaceShellTargetReader<DB>(db: Kysely<DB>, dialect: 'postgres' | 'sqlite') {
  const read = createWorkspaceShellTargetReader(db, dialect)
  return async (rawOwner: string) => {
    const canonical = dataContext(rawOwner).ownerId
    const owner = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const row = (await sql<{ id: number }>`SELECT w.id FROM workspaces w JOIN workspace_directories d ON d.id=w.directory_id
      WHERE w.user_id=${owner} AND w.enabled=TRUE AND d.user_id=${owner} AND d.is_default=TRUE AND d.deleted_at IS NULL
      ORDER BY w.id LIMIT 1`.execute(db)).rows[0]
    return row ? read(rawOwner, Number(row.id)) : null
  }
}

/** 获取当前用户可挂载的活动 Workspace 目录；最终文件系统可用性由 Host 检查。 */
export function createWorkspaceShellDirectoryReader<DB>(db: Kysely<DB>, dialect: 'postgres' | 'sqlite') {
  return async (rawOwner: string) => {
    const canonical = dataContext(rawOwner).ownerId
    const owner = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const rows = await sql<{ id: number; directory_name: string; is_default: boolean | number }>`SELECT id,directory_name,is_default FROM workspace_directories
      WHERE user_id=${owner} AND deleted_at IS NULL ORDER BY is_default DESC,name,id`.execute(db)
    return rows.rows.map(row => ({ id: Number(row.id), directoryName: row.directory_name, isDefault: Boolean(row.is_default) }))
  }
}
