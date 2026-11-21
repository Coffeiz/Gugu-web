import { acceptsPreferenceTextFilename, decodePreferenceTextUpload, MAX_PREFERENCE_TEXT_UPLOAD_BYTES } from '@gugu/core/preferences/text-upload'
import { CoreError, createPreferenceService, parsePreferenceRequest as requestBody } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { PreferenceTextFiles, PreferenceTextKind } from './persistence/personality-files.js'
import { registerUserSmtpSettingsRoutes, type UserSmtpSettingsStore, type UserSmtpTestInput } from './smtp.js'
import { sendUserSmtpTestEmail } from '../../adapters/email/smtp-email.js'
import { registerUserSmtpPreviewRoute } from './smtp-preview.js'

export interface PreferencesStore {
  /** Reads the owner-scoped JSON document; null means no preference row exists yet. */
  read(ownerId: string): Promise<unknown>
  /** Replaces the merged owner-scoped JSON document as one durable operation. */
  write(ownerId: string, data: Record<string, unknown>): Promise<void>
  textFiles?: PreferenceTextFiles
  personalityPreferenceAvailable?: boolean
  invalidatePersonalitySnapshots?(ownerId: string): Promise<void>
  bumpPreferencesContextRevision?(ownerId: string): Promise<unknown>
  smtp?: UserSmtpSettingsStore
}

export interface PreferencesRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  userEmailFromRequest(request: FastifyRequest): string
  smtpTestEmail?(input: UserSmtpTestInput): Promise<void>
  store: PreferencesStore
  textFiles?: PreferenceTextFiles
  personalityPreferenceAvailable?: boolean
  invalidatePersonalitySnapshots?(ownerId: string): Promise<void>
  bumpPreferencesContextRevision?(ownerId: string): Promise<unknown>
  smtpStore?: UserSmtpSettingsStore
  emailChangeAvailable?: boolean
}

async function uploadedText(request: FastifyRequest, kind: PreferenceTextKind): Promise<string> {
  const part = await request.file()
  if (!part) throw new CoreError('invalid_request', '缺少上传文件')
  if (!acceptsPreferenceTextFilename(kind, part.filename || '')) throw Object.assign(new Error(kind === 'reply-style'
    ? '回复风格文件必须是 Markdown 或 TXT 文件' : '人格文件必须是 Markdown（.md）文件'), { statusCode: 415 })
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of part.file) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length <= MAX_PREFERENCE_TEXT_UPLOAD_BYTES) chunks.push(buffer)
  }
  if (part.file.truncated || length > MAX_PREFERENCE_TEXT_UPLOAD_BYTES) throw Object.assign(new Error('偏好文件过大'), { statusCode: 413 })
  let content: string
  try {
    content = decodePreferenceTextUpload(Buffer.concat(chunks))
  } catch {
    throw Object.assign(new Error('偏好文件必须使用 UTF-8 编码'), { statusCode: 400 })
  }
  return content
}

export function registerPreferencesRoutes(app: FastifyInstance, options: PreferencesRouteOptions): void {
  registerUserSmtpPreviewRoute(app, options.requireUser)
  const personalityAvailable = options.personalityPreferenceAvailable
    ?? options.store.personalityPreferenceAvailable
    ?? false
  const service = createPreferenceService(options)
  app.get('/api/v1/preferences', { preHandler: options.requireUser }, request => service.get(options.ownerIdFromRequest(request)))
  app.patch('/api/v1/preferences', { preHandler: options.requireUser }, request => service.patch(options.ownerIdFromRequest(request), request.body))

  app.patch('/api/v1/preferences/reply-style', { preHandler: options.requireUser }, async (request) => {
    const body = requestBody(request.body)
    if (!Object.hasOwn(body, 'content')) throw new CoreError('invalid_request', 'content 无效')
    return service.updateText(options.ownerIdFromRequest(request), 'reply-style', body.content)
  })

  for (const kind of ['personality', 'group-personality', 'reply-style'] as const) {
    app.post(`/api/v1/preferences/${kind === 'group-personality' ? 'group-personality' : kind}/upload`,
      { preHandler: options.requireUser }, async (request) => {
        if (kind !== 'reply-style' && !personalityAvailable)
          throw Object.assign(new Error('用户人格偏好当前未开放'), { statusCode: 403 })
        const content = await uploadedText(request, kind)
        return service.updateText(options.ownerIdFromRequest(request), kind, content)
      })
  }

  const smtpStore = options.smtpStore ?? options.store.smtp
  if (smtpStore) {
    registerUserSmtpSettingsRoutes(app, {
      requireUser: options.requireUser,
      ownerIdFromRequest: options.ownerIdFromRequest,
      userEmailFromRequest: options.userEmailFromRequest,
      store: smtpStore,
      sendTestEmail: options.smtpTestEmail ?? sendUserSmtpTestEmail,
    })
  }
}
