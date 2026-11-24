import { strip } from '../shared/values.js'
import { CoreError, dataContext } from '../contracts/index.js'
import type { Fields } from '../contracts/index.js'

export type WorkspaceKind = 'project' | 'directory'
export interface WorkspaceDeclaration {
  id: number; name: string; kind: WorkspaceKind
  projectId: number | null; directoryId: number | null; enabled: boolean
  isDefault: boolean; boundSessionCount: number
}
export class WorkspaceUpdateError extends Error {
  constructor(readonly statusCode: 400 | 404, message: string) { super(message); this.name = 'WorkspaceUpdateError' }
}
export interface WorkspaceDeclarationTransaction {
  relationExists(owner: string, kind: WorkspaceKind, id: number): Promise<boolean>
  insert(owner: string, workspace: Omit<WorkspaceDeclaration, 'id' | 'isDefault' | 'boundSessionCount'>): Promise<WorkspaceDeclaration>
  get(owner: string, id: number): Promise<WorkspaceDeclaration | null>
  /** 校验目录 owner、系统目录和名称唯一性，并在本事务同步同 owner 的声明显示名。 */
  renameDirectory(owner: string, id: number, name: string): Promise<void>
  update(owner: string, id: number, fields: { name?: string; enabled?: boolean }): Promise<void>
}
export interface WorkspaceDeclarationRuntime {
  transaction<T>(work: (tx: WorkspaceDeclarationTransaction) => Promise<T>): Promise<T>
}
function invalid(message: string): never { throw new CoreError('invalid_request', message) }
function inputObject(input: unknown): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid('请求内容必须是对象')
  return input as Fields
}
function nameValue(value: unknown): string {
  if (typeof value !== 'string') return invalid('名称必须是文本')
  if (Array.from(value).length < 1 || Array.from(value).length > 200) return invalid('名称长度必须为 1 至 200 个字符')
  return value
}
function optionalId(value: unknown, label: string): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid(`${label} 必须是正整数或空值`)
  return value
}
export function createWorkspaceDeclarationCreator(runtime: WorkspaceDeclarationRuntime) {
  return async (rawOwner: string, rawInput: Fields): Promise<WorkspaceDeclaration> => {
    const owner = dataContext(rawOwner).ownerId, input = inputObject(rawInput)
    const name = nameValue(input.name).trim()
    const kind = input.kind
    if (kind !== 'project' && kind !== 'directory') return invalid('工作区类型无效')
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return invalid('enabled 必须是布尔值')
    const projectId = optionalId(input.projectId, 'projectId')
    const directoryId = optionalId(input.directoryId, 'directoryId')
    const id = kind === 'project' ? projectId : directoryId
    return runtime.transaction(async tx => {
      if (id === null || !(await tx.relationExists(owner, kind, id)))
        throw new CoreError('conflict', kind === 'project' ? '项目不存在' : 'Workspace 目录不存在')
      return tx.insert(owner, { name, kind,
        projectId: kind === 'project' ? projectId : null, directoryId: kind === 'directory' ? directoryId : null,
        enabled: input.enabled === undefined ? true : input.enabled as boolean })
    })
  }
}
export function createWorkspaceDeclarationUpdater(runtime: WorkspaceDeclarationRuntime) {
  return async (rawOwner: string, id: number, rawInput: Fields): Promise<WorkspaceDeclaration> => {
    const owner = dataContext(rawOwner).ownerId, input = inputObject(rawInput)
    if (input.name != null && typeof input.name !== 'string') return invalid('名称必须是文本或空值')
    const name = input.name == null ? null : nameValue(input.name)
    if (input.enabled != null && typeof input.enabled !== 'boolean') return invalid('enabled 必须是布尔值或空值')
    if (!Number.isSafeInteger(id) || id < 1) return invalid('工作区 ID 无效')
    return runtime.transaction(async tx => {
      const workspace = await tx.get(owner, id)
      if (!workspace) throw new WorkspaceUpdateError(404, '工作区不存在')
      const fields: { name?: string; enabled?: boolean } = {}
      if (name !== null) {
        const normalized = strip(name)
        if (!normalized) throw new WorkspaceUpdateError(400, '工作区名称不能为空')
        if (workspace.kind === 'directory') {
          if (workspace.directoryId === null) throw new WorkspaceUpdateError(404, '工作区目录不存在')
          await tx.renameDirectory(owner, workspace.directoryId, normalized)
        } else fields.name = normalized
      }
      if (input.enabled != null) fields.enabled = input.enabled as boolean
      if (Object.keys(fields).length) await tx.update(owner, id, fields)
      return (await tx.get(owner, id))!
    })
  }
}
