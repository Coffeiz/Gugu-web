import { CoreError } from '../contracts/index.js'
import type { Fields, ProjectRecord } from '../contracts/index.js'
import { safeInteger } from '../shared/values.js'
import { prepareProjectCreate, prepareProjectUpdate } from './domain.js'

export interface ProjectRepository {
  list(archived?: boolean): Promise<ProjectRecord[]>
  findByName(name: string): Promise<ProjectRecord[]>
  listDeleted(since: string): Promise<ProjectRecord[]>
  get(id: number, includeDeleted?: boolean): Promise<ProjectRecord | null>
  create(values: Fields): Promise<ProjectRecord>
  update(id: number, version: number, values: Fields): Promise<boolean>
}
export class ProjectService {
  constructor(readonly repository: ProjectRepository) {}
  get(id: number, includeDeleted?: boolean): Promise<ProjectRecord | null> {
    safeInteger(id)
    return this.repository.get(id, includeDeleted)
  }
  list(archived = false): Promise<ProjectRecord[]> {
    return this.repository.list(archived)
  }
  listDeleted(since: string): Promise<ProjectRecord[]> {
    return this.repository.listDeleted(since)
  }
  findByName(name: string): Promise<ProjectRecord[]> {
    return this.repository.findByName(name)
  }
  create(fields: Fields): Promise<ProjectRecord> {
    return this.repository.create(prepareProjectCreate(fields))
  }
  async update(id: number, version: number, fields: Fields): Promise<ProjectRecord> {
    safeInteger(id)
    safeInteger(version)
    const existing = await this.repository.get(id)
    if (!existing) throw new CoreError('not_found', '项目不存在')
    if (!Object.keys(fields).length)
      throw new CoreError('invalid_request', '请提供需要更新的项目字段')
    if (!(await this.repository.update(id, version, prepareProjectUpdate(fields, existing))))
      throw new CoreError('conflict', '项目已变化，请重新读取后再修改')
    const updated = await this.repository.get(id)
    if (!updated) throw new CoreError('not_found', '项目不存在')
    return updated
  }
}
