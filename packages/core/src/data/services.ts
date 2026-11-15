import type { ProjectService } from '../projects/service.js'
import type { ClientService } from '../clients/service.js'

export interface DataServices {
  projects: ProjectService
  clients: ClientService
}
