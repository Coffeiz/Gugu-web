import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import type { UserFromRequest } from '../../src/app.js'
import { registerWorkspaceRoutes } from '../../src/domains/workspaces/routes/workspaces.js'
import { WorkspaceUpdateError } from '../../src/domains/workspaces/persistence/workspace-update.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

test('PATCH workspace route passes authenticated owner, path ID, body, and response', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const calls: unknown[] = []
  const userFromRequest = (() => ({
    requestContext: { data: { ownerId } },
  })) as unknown as UserFromRequest
  const updateWorkspace = async (userId: string, workspaceId: number, input: unknown) => {
    calls.push([userId, workspaceId, input])
    return {
      id: workspaceId,
      name: '已更新工作区',
      kind: 'directory',
      folderId: null,
      projectId: null,
      directoryId: 31,
      enabled: false,
      isDefault: false,
      boundSessionCount: 2,
    }
  }
  registerWorkspaceRoutes(app, userFromRequest, async () => null, undefined, updateWorkspace)
  try {
    const body = { name: '新名称', enabled: false }
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/workspaces/41', payload: body,
    })
    const invalid = await app.inject({ method: 'PATCH', url: '/api/v1/workspaces/not-an-id', payload: body })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      id: 41,
      name: '已更新工作区',
      kind: 'directory',
      folderId: null,
      projectId: null,
      directoryId: 31,
      enabled: false,
      isDefault: false,
      boundSessionCount: 2,
    })
    assert.equal(invalid.statusCode, 422)
    assert.deepEqual(calls, [[ownerId, 41, body]])
  } finally {
    await app.close()
  }
})

test('PATCH workspace route preserves updater 400 and 404 error status/detail', async () => {
  const app = Fastify({ logger: false })
  installHttpErrorHandler(app)
  const userFromRequest = (() => ({
    requestContext: { data: { ownerId } },
  })) as unknown as UserFromRequest
  const updateWorkspace = async (_userId: string, workspaceId: number) => {
    if (workspaceId === 41) throw new WorkspaceUpdateError(400, '工作区名称不能为空')
    throw new CoreError('not_found', '工作区不存在')
  }
  registerWorkspaceRoutes(app, userFromRequest, async () => null, undefined, updateWorkspace)
  try {
    const invalidName = await app.inject({ method: 'PATCH', url: '/api/v1/workspaces/41', payload: { name: ' ' } })
    const missing = await app.inject({ method: 'PATCH', url: '/api/v1/workspaces/999', payload: { enabled: false } })

    assert.equal(invalidName.statusCode, 400)
    assert.deepEqual(invalidName.json(), { detail: '工作区名称不能为空' })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: '工作区不存在' })
  } finally {
    await app.close()
  }
})
