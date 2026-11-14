import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { PreferenceTextFiles, PreferenceTextKind } from './persistence/personality-files.js'
import { registerUserSmtpSettingsRoutes, type UserSmtpSettingsStore, type UserSmtpTestInput } from './smtp.js'
import { sendUserSmtpTestEmail } from '../auth/smtp-email.js'
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

interface PreferenceField {
  camel: string
  snake: string
  kind: 'boolean' | 'string' | 'enum' | 'string-list' | 'object-list'
  values?: readonly string[]
  persistUnknown?: boolean
}

const supportedFields: readonly PreferenceField[] = [
  { camel: 'locale', snake: 'locale', kind: 'enum', values: ['zh-CN', 'ja-JP', 'en-US'] },
  { camel: 'theme', snake: 'theme', kind: 'enum', values: ['light', 'dark', 'system'] },
  { camel: 'themeFamily', snake: 'theme_family', kind: 'enum', values: ['glass', 'mono'] },
  { camel: 'palette', snake: 'palette', kind: 'enum', values: ['cafe', 'neutral', 'red', 'blue', 'green'] },
  { camel: 'lastStages', snake: 'last_stages', kind: 'string-list' },
  { camel: 'stageTemplates', snake: 'stage_templates', kind: 'object-list' },
  { camel: 'pmStagesExpanded', snake: 'pm_stages_expanded', kind: 'boolean' },
  { camel: 'calendarWeekStart', snake: 'calendar_week_start', kind: 'string', persistUnknown: true },
  { camel: 'defaultView', snake: 'default_view', kind: 'string', persistUnknown: true },
  { camel: 'shellEnabled', snake: 'shell_enabled', kind: 'boolean' },
  { camel: 'shellSystemEnabled', snake: 'shell_system_enabled', kind: 'boolean' },
  { camel: 'shellDangerousEnabled', snake: 'shell_dangerous_enabled', kind: 'boolean' },
  { camel: 'automaticModeEnabled', snake: 'automatic_mode_enabled', kind: 'boolean' },
  { camel: 'decisionGuardEnabled', snake: 'decision_guard_enabled', kind: 'boolean' },
  { camel: 'imToolDisplayMode', snake: 'im_tool_display_mode', kind: 'enum', values: ['off', 'all', 'slow_only'] },
  { camel: 'showIntermediateReplies', snake: 'show_intermediate_replies', kind: 'boolean' },
  { camel: 'toolInjectionMode', snake: 'tool_injection_mode', kind: 'string', persistUnknown: true },
]

const unsupportedPatchFields = new Set([
  'smtp', 'smtpConfig', 'smtp_config', 'smtpHost', 'smtp_host', 'smtpPort', 'smtp_port',
  'smtpPassword', 'smtp_password', 'personalityUpload', 'personality_upload',
  'replyStyle', 'reply_style', 'upload', 'emailChangeEnabled',
])

const defaultViews = new Set(['projects', 'calendar', 'files', 'mind'])
const legacyPalettes: Record<string, string> = {
  mist: 'blue', rose: 'red', sky: 'blue', sage: 'green', lavender: 'blue',
  amber: 'neutral', aero: 'blue', mono: 'neutral', coral: 'red', teal: 'green',
}
const legacyToolInjectionModes: Record<string, string> = {
  catalog: 'description', compact_schema: 'full', full_schema: 'full',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requestBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new CoreError('invalid_request', '请求体无效')
  return body
}

function preferenceData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? { ...parsed } : {}
    } catch {
      return {}
    }
  }
  return isRecord(value) ? { ...value } : {}
}

function readField(data: Record<string, unknown>, camel: string, snake = camel): unknown {
  return data[snake] === undefined ? data[camel] : data[snake]
}

function pythonTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return true
}

function oneOf(value: unknown, options: readonly string[]): value is string {
  return typeof value === 'string' && options.includes(value)
}

function normalizePalette(value: unknown): string {
  if (oneOf(value, ['cafe', 'neutral', 'red', 'blue', 'green'])) return value
  return typeof value === 'string' ? (legacyPalettes[value] ?? 'neutral') : 'neutral'
}

function normalizeToolInjectionMode(value: unknown): string {
  if (value === undefined || value === null) return 'description'
  if (value === 'description' || value === 'full') return value
  return typeof value === 'string' ? (legacyToolInjectionModes[value] ?? 'full') : 'full'
}

function normalizePreferences(
  data: Record<string, unknown>,
  text: { replyStyle: string | null; personality: string | null; groupPersonality: string | null },
  personalityAvailable: boolean,
): Record<string, unknown> {
  const locale = readField(data, 'locale')
  const theme = readField(data, 'theme')
  const themeFamily = readField(data, 'themeFamily', 'theme_family')
  const weekStart = readField(data, 'calendarWeekStart', 'calendar_week_start')
  const defaultView = readField(data, 'defaultView', 'default_view')
  const stages = readField(data, 'lastStages', 'last_stages')
  const templates = readField(data, 'stageTemplates', 'stage_templates')
  const imToolMode = readField(data, 'imToolDisplayMode', 'im_tool_display_mode')

  return {
    locale: oneOf(locale, ['zh-CN', 'ja-JP', 'en-US']) ? locale : null,
    theme: oneOf(theme, ['light', 'dark', 'system']) ? theme : 'light',
    themeFamily: oneOf(themeFamily, ['glass', 'mono']) ? themeFamily : 'glass',
    palette: normalizePalette(readField(data, 'palette')),
    lastStages: Array.isArray(stages) && stages.every((item) => typeof item === 'string') ? stages : [],
    stageTemplates: Array.isArray(templates) && templates.every(isRecord) ? templates : [],
    customReplyStyle: text.replyStyle,
    customReplyStyleEnabled: pythonTruthy(readField(data, 'customReplyStyleEnabled', 'custom_reply_style_enabled')),
    pmStagesExpanded: pythonTruthy(readField(data, 'pmStagesExpanded', 'pm_stages_expanded')),
    calendarWeekStart: weekStart === 'sunday' ? 'sunday' : 'monday',
    defaultView: typeof defaultView === 'string' && defaultViews.has(defaultView) ? defaultView : 'projects',
    shellEnabled: pythonTruthy(readField(data, 'shellEnabled', 'shell_enabled') ?? true),
    shellSystemEnabled: pythonTruthy(readField(data, 'shellSystemEnabled', 'shell_system_enabled') ?? false),
    shellDangerousEnabled: pythonTruthy(readField(data, 'shellDangerousEnabled', 'shell_dangerous_enabled') ?? true),
    automaticModeEnabled: pythonTruthy(readField(data, 'automaticModeEnabled', 'automatic_mode_enabled') ?? false),
    decisionGuardEnabled: pythonTruthy(readField(data, 'decisionGuardEnabled', 'decision_guard_enabled') ?? false),
    imToolDisplayMode: oneOf(imToolMode, ['off', 'all', 'slow_only']) ? imToolMode : 'all',
    showIntermediateReplies: pythonTruthy(readField(data, 'showIntermediateReplies', 'show_intermediate_replies') ?? false),
    toolInjectionMode: normalizeToolInjectionMode(readField(data, 'toolInjectionMode', 'tool_injection_mode')),
    personalityPreference: text.personality,
    personalityPreferenceEnabled: Boolean(text.personality && pythonTruthy(readField(data, 'personalityPreferenceEnabled', 'personality_preference_enabled'))),
    groupPersonalityPreference: text.groupPersonality,
    groupPersonalityPreferenceEnabled: Boolean(text.groupPersonality && pythonTruthy(readField(data, 'groupPersonalityPreferenceEnabled', 'group_personality_preference_enabled'))),
    personalityPreferenceRevision: revision(readField(data, 'personalityPreferenceRevision', 'personality_preference_revision')),
    personalityPreferenceUpdatedAt: updatedAt(readField(data, 'personalityPreferenceUpdatedAt', 'personality_preference_updated_at')),
    personalityPreferenceAvailable: personalityAvailable,
    emailChangeEnabled: false,
  }
}

function revision(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function updatedAt(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const source = String(value)
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(source)
  const normalized = dateOnly ? `${dateOnly[1]}T00:00:00` : source.replace(' ', 'T')
  const datePart = normalized.slice(0, 10)
  const calendarDate = new Date(`${datePart}T00:00:00Z`)
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== datePart) return null
  return Number.isFinite(new Date(normalized).getTime()) ? normalized : null
}

function normalizeText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new CoreError('invalid_request', `${label} 无效`)
  const normalized = value.trim()
  if ([...normalized].length > 10000) throw new CoreError('invalid_request', `${label}不能超过 10000 个字符`)
  if ([...normalized].some((char) => char === '\0' || char === '\ufeff' || (char.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(char))))
    throw new CoreError('invalid_request', `${label}包含不支持的控制字符`)
  return normalized || null
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false
  }
  throw new CoreError('invalid_request', `${field} 无效`)
}

function parseValue(value: unknown, field: PreferenceField): unknown {
  if (value === null) return null
  switch (field.kind) {
    case 'boolean': return parseBoolean(value, field.camel)
    case 'string':
      if (typeof value !== 'string') throw new CoreError('invalid_request', `${field.camel} 无效`)
      return value
    case 'enum':
      if (!oneOf(value, field.values ?? [])) throw new CoreError('invalid_request', `${field.camel} 无效`)
      return value
    case 'string-list':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
        throw new CoreError('invalid_request', `${field.camel} 无效`)
      return value
    case 'object-list':
      if (!Array.isArray(value) || !value.every(isRecord)) throw new CoreError('invalid_request', `${field.camel} 无效`)
      return value
  }
}

function shouldPersist(field: PreferenceField, value: unknown): boolean {
  if (field.camel === 'calendarWeekStart') return value === 'monday' || value === 'sunday'
  if (field.camel === 'defaultView') return typeof value === 'string' && defaultViews.has(value)
  if (field.camel === 'toolInjectionMode') return value === 'description' || value === 'full'
  return true
}

function patchPreferences(body: unknown): Record<string, unknown> {
  const value = requestBody(body)
  const unsupported = Object.keys(value).find((key) => unsupportedPatchFields.has(key))
  if (unsupported) throw new CoreError('invalid_request', `${unsupported} 暂未开放`)
  const patch: Record<string, unknown> = {}
  for (const field of supportedFields) {
    const input = value[field.camel] === undefined ? value[field.snake] : value[field.camel]
    if (input === undefined || input === null) continue
    const parsed = parseValue(input, field)
    if (field.persistUnknown && !shouldPersist(field, parsed)) continue
    patch[field.snake] = parsed
  }
  for (const [camel, snake] of [
    ['customReplyStyleEnabled', 'custom_reply_style_enabled'],
    ['personalityPreferenceEnabled', 'personality_preference_enabled'],
    ['groupPersonalityPreferenceEnabled', 'group_personality_preference_enabled'],
  ] as const) {
    const input = value[camel] === undefined ? value[snake] : value[camel]
    if (input !== undefined && input !== null) patch[snake] = parseBoolean(input, camel)
  }
  return patch
}

function textFiles(options: PreferencesRouteOptions): PreferenceTextFiles {
  const files = options.textFiles ?? options.store.textFiles
  if (!files) throw new Error('用户偏好文件存储未配置')
  return files
}

async function readText(files: PreferenceTextFiles | undefined, ownerId: string, kind: PreferenceTextKind) {
  if (!files) return null
  const content = await files.read(ownerId, kind)
  return normalizeText(content, kind === 'reply-style' ? '回复风格' : '人格偏好')
}

async function responseData(options: PreferencesRouteOptions, ownerId: string, data: Record<string, unknown>) {
  const files = options.textFiles ?? options.store.textFiles
  const [replyStyle, personality, groupPersonality] = await Promise.all([
    readText(files, ownerId, 'reply-style'),
    readText(files, ownerId, 'personality'),
    readText(files, ownerId, 'group-personality'),
  ])
  return {
    ...normalizePreferences(data, { replyStyle, personality, groupPersonality },
      options.personalityPreferenceAvailable ?? options.store.personalityPreferenceAvailable ?? false),
    emailChangeEnabled: options.emailChangeAvailable ?? false,
  }
}

async function migrateLegacyReplyStyle(
  options: PreferencesRouteOptions,
  ownerId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const legacy = data.custom_reply_style
  if (typeof legacy === 'string' && legacy) {
    const files = options.textFiles ?? options.store.textFiles
    if (files && await files.read(ownerId, 'reply-style') === null) {
      await files.write(ownerId, 'reply-style', normalizeText(legacy, '回复风格'))
    }
  }
  if ('custom_reply_style' in data) {
    delete data.custom_reply_style
    await options.store.write(ownerId, data)
  }
}

async function persistChangedText(options: PreferencesRouteOptions, ownerId: string): Promise<void> {
  await (options.invalidatePersonalitySnapshots ?? options.store.invalidatePersonalitySnapshots)?.(ownerId)
  await (options.bumpPreferencesContextRevision ?? options.store.bumpPreferencesContextRevision)?.(ownerId)
}

async function uploadedText(request: FastifyRequest, kind: PreferenceTextKind): Promise<string | null> {
  const part = await request.file()
  if (!part) throw new CoreError('invalid_request', '缺少上传文件')
  const filename = (part.filename || '').trim().toLowerCase()
  const allowed = kind === 'reply-style' ? filename.endsWith('.md') || filename.endsWith('.txt') : filename.endsWith('.md')
  if (!allowed) throw Object.assign(new Error(kind === 'reply-style'
    ? '回复风格文件必须是 Markdown 或 TXT 文件' : '人格文件必须是 Markdown（.md）文件'), { statusCode: 415 })
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of part.file) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length <= 40000) chunks.push(buffer)
  }
  if (part.file.truncated || length > 40000) throw Object.assign(new Error('偏好文件过大'), { statusCode: 413 })
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw Object.assign(new Error('偏好文件必须使用 UTF-8 编码'), { statusCode: 400 })
  }
  return normalizeText(content, kind === 'reply-style' ? '回复风格' : '人格偏好')
}

async function updateTextRoute(
  options: PreferencesRouteOptions,
  ownerId: string,
  kind: PreferenceTextKind,
  content: string | null,
): Promise<Record<string, unknown>> {
  const files = textFiles(options)
  const data = preferenceData(await options.store.read(ownerId))
  if (kind === 'reply-style') delete data.custom_reply_style
  if (kind === 'personality') {
    delete data.personality_preference
    delete data.personality_preference_updated_at
  }
  if (kind === 'group-personality') delete data.group_personality_preference
  const changed = await files.write(ownerId, kind, content)
  if (kind === 'personality' || kind === 'group-personality') {
    if (changed) data.personality_preference_revision = revision(data.personality_preference_revision) + 1
  }
  if (kind === 'reply-style' && data.custom_reply_style_enabled === undefined)
    data.custom_reply_style_enabled = false
  await options.store.write(ownerId, data)
  if (changed) await persistChangedText(options, ownerId)
  return responseData(options, ownerId, data)
}

export function registerPreferencesRoutes(app: FastifyInstance, options: PreferencesRouteOptions): void {
  registerUserSmtpPreviewRoute(app, options.requireUser)
  const personalityAvailable = options.personalityPreferenceAvailable
    ?? options.store.personalityPreferenceAvailable
    ?? false
  app.get('/api/v1/preferences', { preHandler: options.requireUser }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    const data = preferenceData(await options.store.read(ownerId))
    await migrateLegacyReplyStyle(options, ownerId, data)
    return responseData(options, ownerId, data)
  })

  app.patch('/api/v1/preferences', { preHandler: options.requireUser }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    const body = requestBody(request.body)
    const patch = patchPreferences(body)
    const hasPersonalityText = ['personalityPreference', 'personality_preference', 'groupPersonalityPreference', 'group_personality_preference']
      .some((key) => key in body)
    const hasPersonalityToggle = ['personalityPreferenceEnabled', 'personality_preference_enabled', 'groupPersonalityPreferenceEnabled', 'group_personality_preference_enabled']
      .some((key) => key in body)
    if ((hasPersonalityText || hasPersonalityToggle) && !personalityAvailable)
      throw Object.assign(new Error('用户人格偏好当前未开放'), { statusCode: 403 })
    const oldData = preferenceData(await options.store.read(ownerId))
    await migrateLegacyReplyStyle(options, ownerId, oldData)
    const merged = { ...oldData, ...patch }
    let changed = false
    if ('personalityPreference' in body || 'personality_preference' in body) {
      const value = normalizeText(body.personalityPreference ?? body.personality_preference, '人格偏好')
      const textChanged = await textFiles(options).write(ownerId, 'personality', value)
      changed = textChanged || changed
      delete merged.personality_preference
      delete merged.personality_preference_updated_at
      if (textChanged) merged.personality_preference_revision = revision(merged.personality_preference_revision) + 1
    }
    if ('groupPersonalityPreference' in body || 'group_personality_preference' in body) {
      const value = normalizeText(body.groupPersonalityPreference ?? body.group_personality_preference, '人格偏好')
      const groupChanged = await textFiles(options).write(ownerId, 'group-personality', value)
      changed = groupChanged || changed
      delete merged.group_personality_preference
      if (groupChanged) merged.personality_preference_revision = revision(merged.personality_preference_revision) + 1
    }
    if ('custom_reply_style' in merged) delete merged.custom_reply_style
    // Python removes this retired key on every update so it cannot leak back into active settings.
    delete merged.shell_autopilot_enabled
    changed = changed || merged.custom_reply_style_enabled !== oldData.custom_reply_style_enabled
      || merged.personality_preference_enabled !== oldData.personality_preference_enabled
      || merged.group_personality_preference_enabled !== oldData.group_personality_preference_enabled
    await options.store.write(ownerId, merged)
    if (changed) await persistChangedText(options, ownerId)
    return responseData(options, ownerId, merged)
  })

  app.patch('/api/v1/preferences/reply-style', { preHandler: options.requireUser }, async (request) => {
    const body = requestBody(request.body)
    if (!Object.hasOwn(body, 'content')) throw new CoreError('invalid_request', 'content 无效')
    return updateTextRoute(options, options.ownerIdFromRequest(request), 'reply-style', normalizeText(body.content, '回复风格'))
  })

  for (const kind of ['personality', 'group-personality', 'reply-style'] as const) {
    app.post(`/api/v1/preferences/${kind === 'group-personality' ? 'group-personality' : kind}/upload`,
      { preHandler: options.requireUser }, async (request) => {
        if (kind !== 'reply-style' && !personalityAvailable)
          throw Object.assign(new Error('用户人格偏好当前未开放'), { statusCode: 403 })
        const content = await uploadedText(request, kind)
        return updateTextRoute(options, options.ownerIdFromRequest(request), kind, content)
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
