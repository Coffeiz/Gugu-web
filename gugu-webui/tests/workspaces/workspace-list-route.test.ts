import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import type { UserFromRequest } from '../../src/app.js'
import { registerWorkspaceRoutes } from '../../src/domains/workspaces/routes/workspaces.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

test('GET workspace route uses authenticated owner and returns complete list snapshot', async () => {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  installHttpErrorHandler(app)
  const calls: string[] = []
  const userFromRequest = (() => ({
    requestContext: { data: { ownerId } },
  })) as unknown as UserFromRequest
  const responseBody = {
    globalEnabled: true,
    sandboxEnabled: true,
    systemGlobalEnabled: false,
    dangerousGlobalEnabled: true,
    automaticModeGlobalEnabled: true,
    userEnabled: true,
    userSystemEnabled: false,
    userDangerousEnabled: false,
    userAutomaticModeEnabled: true,
    filesystemAuthorizationEnabled: true,
    workspaceSupported: true,
    terminalMode: 'pty_disabled',
    terminalEntryEnabled: true,
    ptyEnabled: false,
    items: [{
      id: 7,
      name: '工作区',
      kind: 'directory',
      folderId: null,
      projectId: null,
      directoryId: 31,
      enabled: false,
      isDefault: true,
      boundSessionCount: 2,
    }],
  }
  const listWorkspaces = async (authenticatedOwnerId: string) => {
    calls.push(authenticatedOwnerId)
    return responseBody
  }
  registerWorkspaceRoutes(app, userFromRequest, async () => null, undefined, undefined, listWorkspaces)
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspaces/' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), responseBody)
    assert.deepEqual(calls, [ownerId])
  } finally {
    await app.close()
  }
})
