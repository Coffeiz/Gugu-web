import type { Kysely, Transaction } from 'kysely'
import { ClientService } from '../clients/service.js'
import { SqlClientRepository } from '../clients/repository.js'
import { ProjectService } from '../projects/service.js'
import { SqlProjectRepository } from '../projects/repository.js'
import type { DataServices } from './services.js'
import type { Clock } from './codec.js'
import type { Database } from './schema.js'

type Session = Kysely<Database> | Transaction<Database>
export type Backend = 'sqlite' | 'postgres'
export function services(
  session: Session,
  owner: string,
  backend: Backend,
  clock: Clock,
): DataServices {
  return {
    projects: new ProjectService(new SqlProjectRepository(session, owner, backend, clock)),
    clients: new ClientService(new SqlClientRepository(session, owner, backend, clock)),
  }
}
