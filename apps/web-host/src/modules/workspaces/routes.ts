import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { CoreError, normalizeWorkspaceDirectoryName } from '@gugu/core'
import type { UserFromRequest, WebUiOptions } from '../../app.js'
import type { WorkspaceBindingOperations } from './bindings.js'
import { renderPathFileThumbnail } from '../files/content.js'
import { sendContent } from '../files/browse.js'
import type { createWorkspaceFileReads, FileDirectory } from './files.js'

export type WorkspaceUpdateRouteHandler = (
  ownerId: string,
  workspaceId: number,
  input: unknown,
) => Promise<unknown>

export type WorkspaceListRouteHandler = (ownerId: string) => Promise<unknown>

export type WorkspaceDeleteRouteHandler = (ownerId: string, workspaceId: number) => Promise<unknown>

function pathId(value: string, name: string): number {
  if (!/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', `${name} 无效`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new CoreError('invalid_request', `${name} 无效`)
  return parsed
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  userFromRequest: UserFromRequest,
  createWorkspace?: NonNullable<WebUiOptions['createWorkspace']>,
  bindings?: WorkspaceBindingOperations,
  updateWorkspace?: WorkspaceUpdateRouteHandler,
  listWorkspaces?: WorkspaceListRouteHandler,
  deleteWorkspace?: WorkspaceDeleteRouteHandler,
): void {
  if (listWorkspaces) {
    app.get('/api/v1/workspaces', async (request) =>
      listWorkspaces(userFromRequest(request).requestContext.data.ownerId),
    )
  }
  if (createWorkspace) {
    app.post('/api/v1/workspaces', async (request) =>
      createWorkspace(userFromRequest(request).requestContext.data.ownerId, request.body),
    )
  }
  if (updateWorkspace) {
    app.patch('/api/v1/workspaces/:workspace_id', async (request) => {
      const params = request.params as { workspace_id: string }
      const ownerId = userFromRequest(request).requestContext.data.ownerId
      return updateWorkspace(ownerId, pathId(params.workspace_id, '工作区 ID'), request.body)
    })
  }
  if (deleteWorkspace) {
    app.delete('/api/v1/workspaces/:workspace_id', async (request) => {
      const params = request.params as { workspace_id: string }
      const ownerId = userFromRequest(request).requestContext.data.ownerId
      return deleteWorkspace(ownerId, pathId(params.workspace_id, '工作区 ID'))
    })
  }
  if (!bindings) return

  app.post('/api/v1/workspaces/:workspace_id/bind/:session_id', async (request) => {
    const params = request.params as { workspace_id: string; session_id: string }
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    return bindings.bind(
      ownerId,
      pathId(params.workspace_id, '工作区 ID'),
      pathId(params.session_id, '会话 ID'),
    )
  })

  app.delete('/api/v1/workspaces/binding/:session_id', async (request) => {
    const params = request.params as { session_id: string }
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    const sessionId = pathId(params.session_id, '会话 ID')
    await bindings.unbind(ownerId, sessionId)
    return { ok: true, sessionId, workspaceId: null }
  })

  app.get('/api/v1/workspaces/session/:session_id', async (request) => {
    const params = request.params as { session_id: string }
    const ownerId = userFromRequest(request).requestContext.data.ownerId
    const sessionId = pathId(params.session_id, '会话 ID')
    return { sessionId, workspace: await bindings.current(ownerId, sessionId) }
  })
}

export interface WorkspaceDirectoryCard {
  id: number
  name: string
  directory_name: string
  is_default: boolean
  is_system: boolean
  file_count: number
  folder_count: number
  bound_session_count: number
  bound_task_count: number
}

export interface WorkspaceDirectoryOperations {
  files?: ReturnType<typeof createWorkspaceFileReads>
  list(ownerId: string): Promise<WorkspaceDirectoryCard[]>
  create(ownerId: string, name: string): Promise<WorkspaceDirectoryCard>
  update(ownerId: string, directoryId: number, name: string): Promise<WorkspaceDirectoryCard>
  previewDelete(ownerId: string, directoryId: number): Promise<WorkspaceDirectoryCard>
  delete(ownerId: string, directoryId: number, expected?: WorkspaceDirectoryCard): Promise<{ ok: true; workspaceDirectoryId: number }>
}

export interface WorkspaceDirectoryRouteOptions {
  /** 认证必须先于 ownerIdFromRequest 与数据操作执行。 */
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  operations: WorkspaceDirectoryOperations
}

function directoryIdFromPath(value: string, label = 'Workspace ID'): number {
  if (!/^[+-]?\d+$/.test(value)) throw new CoreError('invalid_request', `${label} 无效`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed))
    throw new CoreError('invalid_request', `${label} 无效`)
  return parsed
}

function directoryName(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new CoreError('invalid_request', '请求内容必须是对象')
  const name = (body as Record<string, unknown>).name
  if (typeof name !== 'string') throw new CoreError('invalid_request', '名称必须是文本')
  if (Array.from(name).length > 200)
    throw new CoreError('invalid_request', '名称长度不能超过 200 个字符')
  return normalizeWorkspaceDirectoryName(name)
}

function cardResponse(row: WorkspaceDirectoryCard) {
  return {
    id: row.id,
    name: row.name,
    directoryName: row.directory_name,
    isDefault: row.is_default,
    isSystem: row.is_system,
    fileCount: row.file_count,
    folderCount: row.folder_count,
    boundSessionCount: row.bound_session_count,
    boundTaskCount: row.bound_task_count,
  }
}

/** 注册 Python workspace_directories_router 对应的五条用户接口。 */
export function registerWorkspaceDirectoryRoutes(
  app: FastifyInstance,
  options: WorkspaceDirectoryRouteOptions,
): void {
  const files = options.operations.files
  if (files) {
    app.get<{ Querystring: { path?: string; download?: string } }>('/api/v1/files/by-path/content', {
      preHandler: options.requireUser,
    }, async (request, reply) => {
      const sandboxPath = request.query.path
      const download = request.query.download
      if (typeof sandboxPath !== 'string' || sandboxPath.length > 4096 || download !== undefined && !['0', '1'].includes(download))
        throw new CoreError('invalid_request', '文件路径无效')
      const source = await files.openSandboxPath(options.ownerIdFromRequest(request), sandboxPath)
      return sendContent(reply, request, {
        file: { name: source.fileName }, handle: source.handle, size: source.size,
        fileName: source.fileName, mimeType: source.mimeType,
      }, download === '1' ? 'attachment' : 'inline')
    })

    const registerFileRoutes = (prefix: string, directory: (params: { directory_id: string }) => FileDirectory) => {
      type FileRequest = { Params: { directory_id: string }; Querystring: { path?: string; download?: string; overwrite?: string; identity?: string; kind?: string } }
      const scope = (request: FastifyRequest<FileRequest>) => {
        const path = request.query.path ?? ''
        if (typeof path !== 'string' || path.length > 4096)
          throw new CoreError('invalid_request', '文件路径无效')
        return [options.ownerIdFromRequest(request), directory(request.params), path] as const
      }
      app.post<FileRequest & { Body: { paths?: unknown } }>(`${prefix}/download-archive`,
        { preHandler: options.requireUser }, async (request, reply) => {
          const paths = request.body?.paths
          if (!Array.isArray(paths) || paths.length === 0 || paths.length > 10_000
            || paths.some(path => typeof path !== 'string' || path.length > 4096))
            throw new CoreError('invalid_request', '下载参数无效')
          const controller = new AbortController()
          const onClose = () => { if (!reply.raw.writableEnded) controller.abort() }
          reply.raw.once('close', onClose)
          try {
            const stream = await files.downloadArchive(options.ownerIdFromRequest(request), directory(request.params), paths, controller.signal)
            stream.once('close', () => reply.raw.off('close', onClose))
            return reply.type('application/zip').header('Content-Disposition', 'attachment; filename="files.zip"').send(stream)
          } catch (error) {
            reply.raw.off('close', onClose)
            throw error
          }
        })
      app.post<FileRequest & { Body: { paths?: unknown; name?: unknown } }>(`${prefix}/compress`,
        { preHandler: options.requireUser }, async (request, reply) => {
          const { paths, name } = request.body ?? {}
          if (!Array.isArray(paths) || paths.length === 0 || paths.length > 10_000
            || paths.some(path => typeof path !== 'string' || path.length > 4096) || typeof name !== 'string')
            throw new CoreError('invalid_request', '压缩参数无效')
          const controller = new AbortController()
          const onClose = () => controller.abort()
          reply.raw.once('close', onClose)
          try {
            return await files.compressArchive(options.ownerIdFromRequest(request), directory(request.params), paths, name.trim(), controller.signal)
          } finally { reply.raw.off('close', onClose) }
        })
      app.post<FileRequest & { Body: { folderName?: unknown } }>(`${prefix}/extract`,
        { preHandler: options.requireUser }, async (request, reply) => {
          const folderName = request.body?.folderName
          if (typeof folderName !== 'string') throw new CoreError('invalid_request', '解压文件夹名称无效')
          const controller = new AbortController()
          const onClose = () => controller.abort()
          reply.raw.once('close', onClose)
          try {
            return await files.extractArchive(...scope(request), folderName.trim(), controller.signal)
          } finally { reply.raw.off('close', onClose) }
        })
      app.post<FileRequest & { Body: { paths?: unknown } }>(`${prefix}/resolve-relative`, { preHandler: options.requireUser }, request => {
        const paths = request.body?.paths
        if (!Array.isArray(paths) || paths.length > 100 || paths.some(path => typeof path !== 'string' || path.length > 4096))
          throw new CoreError('invalid_request', '文件引用参数无效')
        if (paths.some(path => path.split('/').length > 64) || paths.reduce((total, path) => total + path.split('/').length, 0) > 256)
          throw new CoreError('invalid_request', '文件引用路径层级过多')
        return files.resolveRelative(...scope(request), paths)
      })
      app.get<FileRequest>(`${prefix}/entries`, { preHandler: options.requireUser }, request => files.list(...scope(request)))
      app.get<FileRequest>(`${prefix}/reference`, { preHandler: options.requireUser }, request =>
        files.reference(...scope(request), request.query.identity, request.query.kind === 'folder' ? 'folder' : 'file'))
      app.get<FileRequest>(`${prefix}/thumb`, { preHandler: options.requireUser }, async (request, reply) => {
        const rendered = await renderPathFileThumbnail(await files.open(...scope(request)))
        return reply.type(rendered.mimeType)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cache-Control', 'private, no-store')
          .send(rendered.bytes)
      })
      app.get<FileRequest>(`${prefix}/content`, { preHandler: options.requireUser }, async (request, reply) => {
        const { identity } = request.query
        if (identity !== undefined && (typeof identity !== 'string' || !/^\d{1,32}\.\d{1,32}\.\d{1,32}$/.test(identity)))
          throw new CoreError('invalid_request', '文件引用无效')
        const source = await files.open(...scope(request), identity)
        reply.header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "sandbox; default-src 'none'")
        return sendContent(reply, request, source, request.query.download === '1' ? 'attachment' : 'inline', 'private, no-store')
      })
      app.post<FileRequest>(`${prefix}/folders`, { preHandler: options.requireUser }, async (request, reply) =>
        reply.code(201).send(await files.mkdir(...scope(request))))
      type DestinationRequest = FileRequest & { Body: { destination?: unknown } }
      function destination(request: FastifyRequest<DestinationRequest>) {
        const path = request.body?.destination
        if (typeof path !== 'string' || !path || path.length > 4096)
          throw new CoreError('invalid_request', '目标路径无效')
        return path
      }
      app.patch<DestinationRequest>(`${prefix}/entries`, { preHandler: options.requireUser }, request =>
        files.move(...scope(request), destination(request)))
      app.post<DestinationRequest>(`${prefix}/copy`, { preHandler: options.requireUser }, async (request, reply) => {
        const controller = new AbortController()
        const onClose = () => { if (!reply.raw.writableEnded) controller.abort() }
        reply.raw.once('close', onClose)
        try {
          return await files.copy(...scope(request), destination(request), controller.signal)
        } finally {
          reply.raw.off('close', onClose)
        }
      })
      app.delete<FileRequest>(`${prefix}/entries`, { preHandler: options.requireUser }, request =>
        files.moveToTrash(...scope(request)))
      app.post<FileRequest>(`${prefix}/content`, { preHandler: options.requireUser }, async (request, reply) => {
        const location = scope(request)
        const overwrite = request.query.overwrite
        if (overwrite !== undefined && overwrite !== '1') throw new CoreError('invalid_request', '上传覆盖选项无效')
        const controller = new AbortController()
        const onClose = () => { if (!reply.raw.writableEnded) controller.abort() }
        reply.raw.once('close', onClose)
        const content = async function* () {
          let uploaded = false
          for await (const part of request.parts()) {
            if (part.type !== 'file' || part.fieldname !== 'file' || uploaded)
              throw new CoreError('invalid_request', '每次只能上传一个文件')
            uploaded = true
            yield* part.file
            if (part.file.truncated)
              throw new CoreError('invalid_request', '上传文件不完整')
          }
          if (!uploaded) throw new CoreError('invalid_request', '缺少上传文件')
        }
        try {
          return reply.code(201).send(await files.upload(...location, content(), controller.signal, overwrite === '1'))
        } finally {
          reply.raw.off('close', onClose)
        }
      })
    }
    const protectedRoute = { preHandler: options.requireUser }
    app.get('/api/v1/files/disk-trash', protectedRoute, request => files.listDiskTrash(options.ownerIdFromRequest(request)))
    app.post<{ Params: { id: string } }>('/api/v1/files/disk-trash/:id/restore', protectedRoute, request =>
      files.restoreDiskTrash(options.ownerIdFromRequest(request), request.params.id))
    app.delete<{ Params: { id: string } }>('/api/v1/files/disk-trash/:id', protectedRoute, request =>
      files.purgeDiskTrash(options.ownerIdFromRequest(request), request.params.id))
    registerFileRoutes('/api/v1/workspace-directories/:directory_id', params => directoryIdFromPath(params.directory_id))
    registerFileRoutes('/api/v1/files/personal', () => 'personal')
    registerFileRoutes('/api/v1/files/projects/:directory_id', params => ({ projectId: directoryIdFromPath(params.directory_id, '项目 ID') }))
  }
  app.get('/api/v1/workspace-directories', {
    preHandler: options.requireUser,
  }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    return (await options.operations.list(ownerId)).map(cardResponse)
  })

  app.post('/api/v1/workspace-directories', {
    preHandler: options.requireUser,
  }, async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    const name = directoryName(request.body)
    return reply.code(201).send(cardResponse(await options.operations.create(ownerId, name)))
  })

  app.patch<{ Params: { directory_id: string } }>('/api/v1/workspace-directories/:directory_id', {
    preHandler: options.requireUser,
  }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    const id = directoryIdFromPath(request.params.directory_id)
    const name = directoryName(request.body)
    return cardResponse(await options.operations.update(ownerId, id, name))
  })

  // Python 当前返回 raw dict（snake_case），而 list/create/update 由响应模型转 camelCase。
  app.get<{ Params: { directory_id: string } }>('/api/v1/workspace-directories/:directory_id/delete-preview', {
    preHandler: options.requireUser,
  }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    return options.operations.previewDelete(ownerId, directoryIdFromPath(request.params.directory_id))
  })

  app.delete<{ Params: { directory_id: string } }>('/api/v1/workspace-directories/:directory_id', {
    preHandler: options.requireUser,
  }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    return options.operations.delete(ownerId, directoryIdFromPath(request.params.directory_id))
  })
}
