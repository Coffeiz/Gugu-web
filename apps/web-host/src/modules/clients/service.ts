import { clientSummary, dataContext, type DataServices } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { ClientCreateInput, ClientResponse } from '../../app.js'

export function createClientOperations(core: SqlDataRuntime) {
  const withOwner = <T>(ownerId: string, work: (data: DataServices) => Promise<T>) =>
    core.transaction(dataContext(ownerId), work)
  return {
    async list(ownerId: string): Promise<ClientResponse[]> {
      return withOwner(ownerId, async (data) =>
        (await data.clients.list()).map(clientSummary),
      )
    },
    async create(ownerId: string, input: ClientCreateInput): Promise<ClientResponse> {
      return withOwner(ownerId, async (data) =>
        clientSummary(await data.clients.create({ ...input })),
      )
    },
    async delete(ownerId: string, clientId: number): Promise<void> {
      await withOwner<void>(ownerId, (data) => data.clients.delete(clientId))
    },
  }
}
