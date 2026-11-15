import type { Generated, Kysely } from 'kysely'
import { WorkspaceUpdateError } from './workspace-declarations.js'
import type { WorkspaceDeclaration, WorkspaceDeclarationRuntime, WorkspaceDeclarationTransaction, WorkspaceKind } from './workspace-declarations.js'
import type { Backend } from '../data/repositories.js'

type Bool = boolean | number
interface WorkspaceTable {
  id: Generated<number>; user_id: string; name: string; kind: WorkspaceKind
  folder_id: number | null; project_id: number | null; directory_id: number | null
  enabled: Bool; is_default: Bool; created_at: string; updated_at: string
}
interface DirectoryTable {
  id: Generated<number>; user_id: string; name: string; directory_name: string
  is_system: Bool; is_default: Bool; deleted_at: string | null; created_at: string; updated_at: string
}
/** 原型显式要求调用方提供完整 workspace 与关联模型；不改变正式 SQLite schema。 */
export interface WorkspaceDeclarationDatabase {
  workspaces: WorkspaceTable
  workspace_directories: DirectoryTable
  folders: { id: Generated<number>; user_id: string; deleted_at: string | null }
  projects: { id: Generated<number>; user_id: string; deleted_at: string | null }
  conversation_sessions: { id: Generated<number>; user_id: string; workspace_id: number | null }
}
export function createKyselyWorkspaceDeclarationRuntime(db: Kysely<WorkspaceDeclarationDatabase>, backend: Backend): WorkspaceDeclarationRuntime {
  const ownerKey = (owner: string) => backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  const bool = (value: boolean): Bool => backend === 'sqlite' ? Number(value) : value
  const adapter = (tx: Kysely<WorkspaceDeclarationDatabase>): WorkspaceDeclarationTransaction => ({
      async relationExists(owner, kind, id) {
        const user = ownerKey(owner)
        if (kind === 'directory') return !!await tx.selectFrom('workspace_directories').select('id').where('user_id', '=', user).where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst()
        const table = kind === 'folder' ? 'folders' : 'projects'
        return !!await tx.selectFrom(table).select('id').where('user_id', '=', user).where('id', '=', id).executeTakeFirst()
      },
      async insert(owner, value) {
        const now = new Date().toISOString()
        const row = await tx.insertInto('workspaces').values({ user_id: ownerKey(owner), name: value.name, kind: value.kind,
          folder_id: value.folderId, project_id: value.projectId, directory_id: value.directoryId,
          enabled: bool(value.enabled), is_default: bool(false), created_at: now, updated_at: now }).returningAll().executeTakeFirstOrThrow()
        return { ...value, id: Number(row.id), isDefault: false, boundSessionCount: 0 }
      },
      async get(owner, id) {
        const user = ownerKey(owner)
        const row = await tx.selectFrom('workspaces').selectAll().where('user_id', '=', user).where('id', '=', id).executeTakeFirst()
        if (!row) return null
        const count = await tx.selectFrom('conversation_sessions').select(({ fn }) => fn.countAll<string>().as('n')).where('user_id', '=', user).where('workspace_id', '=', id).executeTakeFirstOrThrow()
        return { id: Number(row.id), name: row.name, kind: row.kind, folderId: row.folder_id, projectId: row.project_id,
          directoryId: row.directory_id, enabled: Boolean(row.enabled), isDefault: Boolean(row.is_default), boundSessionCount: Number(count.n) } satisfies WorkspaceDeclaration
      },
      async renameDirectory(owner, id, name) {
        const user = ownerKey(owner)
        let query = tx.selectFrom('workspace_directories').selectAll().where('user_id', '=', user).where('id', '=', id).where('deleted_at', 'is', null)
        if (backend === 'postgres') query = query.forUpdate()
        const row = await query.executeTakeFirst()
        if (!row) throw new WorkspaceUpdateError(404, 'Workspace 不存在')
        if (row.is_system) throw new WorkspaceUpdateError(400, '默认 Workspace 不可重命名')
        const safe = name.replace(/[\\/:*?"<>|]/g, '_')
        if (['workspace', 'shell', '个人文件', '项目文件', '思维', '素材板'].includes(safe) || name.toLowerCase() === 'default')
          throw new WorkspaceUpdateError(400, 'Workspace 名称与系统目录冲突')
        if (row.name === name) return
        const duplicate = await tx.selectFrom('workspace_directories').select('id').where('user_id', '=', user).where('name', '=', name).where('deleted_at', 'is', null).where('id', '!=', id).executeTakeFirst()
        if (duplicate) throw new WorkspaceUpdateError(400, 'Workspace 已存在')
        try {
          const now = new Date().toISOString()
          await tx.updateTable('workspace_directories').set({ name, updated_at: now }).where('user_id', '=', user).where('id', '=', id).execute()
          await tx.updateTable('workspaces').set({ name, updated_at: now }).where('user_id', '=', user).where('directory_id', '=', id).execute()
        } catch (error) {
          const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
          if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') throw new WorkspaceUpdateError(400, 'Workspace 已存在')
          throw error
        }
      },
      async update(owner, id, fields) {
        await tx.updateTable('workspaces').set({ ...(fields.name === undefined ? {} : { name: fields.name }),
          ...(fields.enabled === undefined ? {} : { enabled: bool(fields.enabled) }), updated_at: new Date().toISOString() })
          .where('user_id', '=', ownerKey(owner)).where('id', '=', id).execute()
      },
  })
  return { transaction: work => db.isTransaction ? work(adapter(db)) : db.transaction().execute(tx => work(adapter(tx))) }
}
