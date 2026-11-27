import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import type { components } from '@/types/api'
import type { RequestMeta } from '@/api/client'

type Schemas = components['schemas']
type ProjectResponse = Schemas['ProjectResponse']

export interface ProjectWorkspaceBinding {
  id: number | `desktop:${string}`
  workspaceId?: number
  name: string
  bound: boolean
  active?: boolean
  available: boolean
}

export interface ProjectAccess {
  pickWorkspace?(): Promise<`desktop:${string}` | null>
  listWorkspaceBindings?(id: number): Promise<ProjectWorkspaceBinding[]>
  selectWorkspace?(id: number, directoryId: `project:${number}` | ProjectWorkspaceBinding['id'], workspaceId?: number): Promise<unknown>
  projectFilesEnabled?: boolean
  storesProjectsLocally: boolean
  list(archived?: boolean, deleted?: boolean): Promise<ProjectResponse[]>
  fileCounts?(): Promise<{ projectId: number; fileCount: number }[]>
  get(id: number): Promise<ProjectResponse>
  create(data: Schemas['ProjectCreate'], idempotencyKey?: string): Promise<ProjectResponse>
  update(id: number, data: Schemas['ProjectUpdate'], meta?: RequestMeta): Promise<ProjectResponse>
  delete(id: number): Promise<unknown>
  purge?(id: number): Promise<unknown>
  restore(id: number): Promise<unknown>
}

export const projectAccessKey: InjectionKey<ProjectAccess> = Symbol('projectAccess')

export function useProjectAccess() {
  const access = hasInjectionContext() ? inject(projectAccessKey, null) : null
  if (!access) throw new Error('项目接口未装配')
  return access
}
