import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import type { UserFromRequest } from '../../src/app.js'
import { createProjectUpdater, type ProjectUpdateRuntime } from '../../src/domains/projects/application/project-update.js'
import { registerProjectRoutes } from '../../src/domains/projects/routes/projects.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const unrelatedUserId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('PATCH project route passes owner, project ID, body and write metadata to updater', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const calls: unknown[] = []
  const userFromRequest = (() => ({ id: unrelatedUserId, requestContext: { data: { ownerId } } })) as unknown as UserFromRequest
  const updateProject = async (...args: unknown[]) => {
    calls.push(args)
    if (args[1] === 0) throw new CoreError('not_found', '项目不存在')
    return { id: 17, name: '已更新', version: 5 }
  }
  registerProjectRoutes(app, userFromRequest, { updateProject } as never)
  try {
    const body = { version: 4, name: '已更新' }
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/projects/17', payload: body,
      headers: { 'x-undo-context-id': 'tab-1', 'x-client-id': 'web-1' },
    })
    const zeroId = await app.inject({ method: 'PATCH', url: '/api/v1/projects/0', payload: body })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { id: 17, name: '已更新', version: 5 })
    assert.equal(zeroId.statusCode, 404)
    assert.deepEqual(calls, [
      [ownerId, 17, body, {
      idempotencyKey: null,
      undoContextId: 'tab-1',
      clientId: 'web-1',
      }], [ownerId, 0, body, {
        idempotencyKey: null,
        undoContextId: null,
        clientId: null,
      }],
    ])
  } finally {
    await app.close()
  }
})

test('PATCH project route maps owner-scoped not found and CAS conflict to HTTP statuses', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const userFromRequest = (() => ({ id: unrelatedUserId, requestContext: { data: { ownerId } } })) as unknown as UserFromRequest
  const updateProject = async (_owner: string, projectId: number) => {
    if (projectId === 17) throw new CoreError('not_found', '项目不存在')
    throw new CoreError('conflict', '数据已被其他用户修改，请刷新后重试')
  }
  registerProjectRoutes(app, userFromRequest, { updateProject } as never)
  try {
    const missing = await app.inject({ method: 'PATCH', url: '/api/v1/projects/17', payload: { version: 1, name: 'x' } })
    const stale = await app.inject({ method: 'PATCH', url: '/api/v1/projects/18', payload: { version: 1, name: 'x' } })
    assert.equal(missing.statusCode, 404)
    assert.equal(stale.statusCode, 409)
  } finally {
    await app.close()
  }
})

test('PATCH maps pre-lookup schema errors to HTTP 422 without opening persistence transaction', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  let transactions = 0
  const userFromRequest = (() => ({ id: unrelatedUserId, requestContext: { data: { ownerId } } })) as unknown as UserFromRequest
  const runtime = {
    async transaction<T>() {
      transactions += 1
      throw new Error('schema validation must happen before persistence')
    },
    async renameProjectDirectory() {},
    async getFileCount() { return 0 },
    async publishProjectUpdated() {},
  } as ProjectUpdateRuntime
  registerProjectRoutes(app, userFromRequest, { updateProject: createProjectUpdater(runtime) })
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/817',
      payload: { name: 42 },
    })
    assert.equal(response.statusCode, 422)
    assert.deepEqual(response.json(), { detail: 'name 必须是文本或空值' })
    assert.equal(transactions, 0)
  } finally {
    await app.close()
  }
})

test('GET and PATCH project routes follow FastAPI signed integer path parsing and owner context', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const calls: unknown[] = []
  const userFromRequest = (() => ({ id: unrelatedUserId, requestContext: { data: { ownerId } } })) as unknown as UserFromRequest
  const getProject = async (owner: string, projectId: number) => {
    calls.push(['get', owner, projectId])
    return projectId === 17 ? { id: projectId, name: '项目' } : null
  }
  const updateProject = async (owner: string, projectId: number) => {
    calls.push(['patch', owner, projectId])
    if (projectId <= 0) throw new CoreError('not_found', '项目不存在')
    return { id: projectId, version: 2 }
  }
  registerProjectRoutes(app, userFromRequest, { getProject, updateProject })
  try {
    const getSigned = await app.inject({ method: 'GET', url: '/api/v1/projects/%2B17' })
    const getNegative = await app.inject({ method: 'GET', url: '/api/v1/projects/-17' })
    const getZero = await app.inject({ method: 'GET', url: '/api/v1/projects/0' })
    const getInvalid = await app.inject({ method: 'GET', url: '/api/v1/projects/not-an-int' })
    const patchSigned = await app.inject({ method: 'PATCH', url: '/api/v1/projects/%2B17', payload: { version: 1, name: 'x' } })
    const patchNegative = await app.inject({ method: 'PATCH', url: '/api/v1/projects/-17', payload: { version: 1, name: 'x' } })
    const patchZero = await app.inject({ method: 'PATCH', url: '/api/v1/projects/0', payload: { version: 1, name: 'x' } })

    assert.equal(getSigned.statusCode, 200)
    assert.equal(getNegative.statusCode, 404)
    assert.equal(getZero.statusCode, 404)
    assert.equal(getInvalid.statusCode, 422)
    assert.equal(patchSigned.statusCode, 200)
    assert.equal(patchNegative.statusCode, 404)
    assert.equal(patchZero.statusCode, 404)
    assert.deepEqual(calls, [
      ['get', ownerId, 17],
      ['get', ownerId, -17],
      ['get', ownerId, 0],
      ['patch', ownerId, 17],
      ['patch', ownerId, -17],
      ['patch', ownerId, 0],
    ])
  } finally {
    await app.close()
  }
})
