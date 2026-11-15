import { CoreError } from '../contracts/index.js'
import { normalizeThemePalette, THEME_PALETTES } from './palette.js'

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
  { camel: 'palette', snake: 'palette', kind: 'enum', values: THEME_PALETTES },
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
    palette: normalizeThemePalette(readField(data, 'palette')),
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

export { requestBody as parsePreferenceRequest, preferenceData as readPreferenceDocument, normalizePreferences as normalizePreferenceResponse, revision as preferenceRevision, normalizeText as normalizePreferenceText, patchPreferences as parsePreferencePatch }
