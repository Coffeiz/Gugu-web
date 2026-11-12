import { CoreError } from '../contracts/index.js'
import type { ClientRecord, Fields, ProjectRecord } from '../contracts/index.js'
import { prepareProjectCreate, prepareProjectUpdate } from '../domain/projects.js'
import { prepareClientFields } from '../domain/clients.js'
import { safeInteger } from '../domain/values.js'

export interface ProjectRepository {
  list(archived?: boolean): Promise<ProjectRecord[]>
  get(id: number): Promise<ProjectRecord | null>
  create(values: Fields): Promise<ProjectRecord>
  update(id: number, version: number, values: Fields): Promise<boolean>
}
export interface ClientRepository {
  list(): Promise<ClientRecord[]>
  get(id: number): Promise<ClientRecord | null>
  create(values: Fields): Promise<ClientRecord>
  update(id: number, values: Fields): Promise<boolean>
  delete(id: number): Promise<boolean>
}
export class ProjectService {
  constructor(readonly repository: ProjectRepository) {}
  get(id: number): Promise<ProjectRecord | null> {
    safeInteger(id)
    return this.repository.get(id)
  }
  list(archived = false): Promise<ProjectRecord[]> {
    return this.repository.list(archived)
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
export class ClientService {
  constructor(readonly repository: ClientRepository) {}
  list(): Promise<ClientRecord[]> {
    return this.repository.list()
  }
  create(fields: Fields): Promise<ClientRecord> {
    return this.repository.create(prepareClientFields(fields, true))
  }
  async update(id: number, fields: Fields): Promise<ClientRecord> {
    safeInteger(id)
    const values = prepareClientFields(fields)
    if (!Object.keys(values).length)
      throw new CoreError('invalid_request', '请提供需要更新的联系人字段')
    if (!(await this.repository.update(id, values)))
      throw new CoreError('not_found', '联系人不存在')
    const updated = await this.repository.get(id)
    if (!updated) throw new CoreError('not_found', '联系人不存在')
    return updated
  }
  async delete(id: number): Promise<void> {
    safeInteger(id)
    if (!(await this.repository.delete(id))) throw new CoreError('not_found', '联系人不存在')
  }
}
export interface DataServices {
  projects: ProjectService
  clients: ClientService
}
