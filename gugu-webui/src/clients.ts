import { dataContext, type ClientRecord, type DataServices } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { ClientCreateInput, ClientResponse } from './app.js'

const CLIENT_RESPONSE_FIELDS = ['id', 'name', 'contact', 'email', 'phone', 'notes'] as const

function clientResponse(client: ClientRecord): ClientResponse {
  return Object.fromEntries(CLIENT_RESPONSE_FIELDS.map((field) => [field, client[field]])) as unknown as ClientResponse
}

export function createClientOperations(core: SqlDataRuntime) {
  const withOwner = <T>(ownerId: string, work: (data: DataServices) => Promise<T>) =>
    core.transaction(dataContext(ownerId), work)
  return {
    async list(ownerId: string): Promise<ClientResponse[]> {
      return withOwner(ownerId, async (data) =>
        (await data.clients.list()).map(clientResponse),
      )
    },
    async create(ownerId: string, input: ClientCreateInput): Promise<ClientResponse> {
      return withOwner(ownerId, async (data) =>
        clientResponse(await data.clients.create(input)),
      )
    },
    async delete(ownerId: string, clientId: number): Promise<void> {
      await withOwner<void>(ownerId, (data) => data.clients.delete(clientId))
    },
  }
}
