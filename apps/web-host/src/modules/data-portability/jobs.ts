import type { FastifyInstance } from 'fastify'
import type { UserFromRequest } from '../../app.js'
import type { createPortabilityJobReader } from '@gugu/core/data-portability/read-jobs'

export function jobUuid(raw: string): string | null {
  const compact = raw.replace(/^urn:uuid:/i, '').replace(/^\{(.*)\}$/, '$1').replaceAll('-', '')
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null
  return `${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}`.toLowerCase()
}

export function registerPortabilityJobReadRoutes(app: FastifyInstance, userFromRequest: UserFromRequest, jobs: ReturnType<typeof createPortabilityJobReader>): void {
  app.get('/api/v1/data-portability/exports', request => jobs.listExports(userFromRequest(request).id))
  app.get('/api/v1/data-portability/imports', request => jobs.listImports(userFromRequest(request).id))
  app.get('/api/v1/data-portability/exports/:job_id', (request, reply) => {
    const owner = userFromRequest(request).id
    const { job_id } = request.params as {job_id:string}
    const canonical = jobUuid(job_id)
    if (canonical === null) return reply.code(422).send({detail:'任务标识必须是 UUID'})
    return jobs.getExport(owner,canonical)
  })
  app.get('/api/v1/data-portability/imports/:job_id', (request, reply) => {
    const owner = userFromRequest(request).id
    const { job_id } = request.params as {job_id:string}
    const canonical = jobUuid(job_id)
    if (canonical === null) return reply.code(422).send({detail:'任务标识必须是 UUID'})
    return jobs.getImport(owner,canonical)
  })
}
