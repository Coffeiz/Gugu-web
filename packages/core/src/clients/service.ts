import { CoreError } from '../contracts/index.js'
import type { ClientRecord, Fields } from '../contracts/index.js'
import { prepareClientFields } from './clients.js'
import { safeInteger } from '../shared/values.js'

/** 联系人字段规则错误；保留 Core invalid_request 状态供 Host 映射。 */
export class ClientValidationError extends CoreError {
  constructor(message: string) {
    super('invalid_request', message)
    this.name = 'ClientValidationError'
  }
}

function clientFields(fields: Fields, creating = false): Fields {
  try {
    const values = prepareClientFields(fields, creating)
    if (!creating && !Object.keys(values).length)
      throw new ClientValidationError('请提供需要更新的联系人字段')
    return values
  } catch (error) {
    if (error instanceof ClientValidationError) throw error
    if (error instanceof CoreError && error.code === 'invalid_request') throw new ClientValidationError(error.message)
    throw error
  }
}

export interface ClientRepository {
  list(): Promise<ClientRecord[]>
  findByName(name: string): Promise<ClientRecord[]>
  get(id: number): Promise<ClientRecord | null>
  create(values: Fields): Promise<ClientRecord>
  update(id: number, values: Fields): Promise<boolean>
  delete(id: number): Promise<boolean>
}
export class ClientService {
  constructor(readonly repository: ClientRepository) {}
  findByName(name: string): Promise<ClientRecord[]> {
    return this.repository.findByName(name)
  }
  list(): Promise<ClientRecord[]> {
    return this.repository.list()
  }
  create(fields: Fields): Promise<ClientRecord> {
    return this.repository.create(clientFields(fields, true))
  }
  async update(id: number, fields: Fields): Promise<ClientRecord> {
    safeInteger(id)
    const values = clientFields(fields)
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
