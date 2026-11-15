import { parsePreferenceRequest as requestBody, readPreferenceDocument as preferenceData, normalizePreferenceResponse as normalizePreferences, preferenceRevision as revision, normalizePreferenceText as normalizeText, parsePreferencePatch as patchPreferences } from './general.js'

export type PreferenceTextKind = 'personality' | 'group-personality' | 'reply-style'
export interface PreferenceTextFiles {
  read(ownerId: string, kind: PreferenceTextKind): Promise<string | null>
  write(ownerId: string, kind: PreferenceTextKind, value: string | null): Promise<boolean>
}
export interface PreferenceDocumentStore {
  read(ownerId: string): Promise<unknown>
  write(ownerId: string, data: Record<string, unknown>): Promise<void>
  textFiles?: PreferenceTextFiles
  personalityPreferenceAvailable?: boolean
  invalidatePersonalitySnapshots?(ownerId: string): Promise<void>
  bumpPreferencesContextRevision?(ownerId: string): Promise<unknown>
}
export interface PreferenceServiceOptions {
  store: PreferenceDocumentStore
  textFiles?: PreferenceTextFiles
  personalityPreferenceAvailable?: boolean
  invalidatePersonalitySnapshots?(ownerId: string): Promise<void>
  bumpPreferencesContextRevision?(ownerId: string): Promise<unknown>
  emailChangeAvailable?: boolean
}

function textFiles(options: PreferenceServiceOptions): PreferenceTextFiles {
  const files = options.textFiles ?? options.store.textFiles
  if (!files) throw new Error('用户偏好文件存储未配置')
  return files
}

async function readText(files: PreferenceTextFiles | undefined, ownerId: string, kind: PreferenceTextKind) {
  if (!files) return null
  const content = await files.read(ownerId, kind)
  return normalizeText(content, kind === 'reply-style' ? '回复风格' : '人格偏好')
}

async function responseData(options: PreferenceServiceOptions, ownerId: string, data: Record<string, unknown>) {
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
  options: PreferenceServiceOptions,
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

async function persistChangedText(options: PreferenceServiceOptions, ownerId: string): Promise<void> {
  await (options.invalidatePersonalitySnapshots ?? options.store.invalidatePersonalitySnapshots)?.(ownerId)
  await (options.bumpPreferencesContextRevision ?? options.store.bumpPreferencesContextRevision)?.(ownerId)
}

async function updateTextRoute(
  options: PreferenceServiceOptions,
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

/** 普通偏好的读取、更新与文本副作用由可信 Host 注入能力。 */
export function createPreferenceService(options: PreferenceServiceOptions) {
  const personalityAvailable = options.personalityPreferenceAvailable ?? options.store.personalityPreferenceAvailable ?? false
  return {
    async get(ownerId: string) {
      const data = preferenceData(await options.store.read(ownerId))
      await migrateLegacyReplyStyle(options, ownerId, data)
      return responseData(options, ownerId, data)
    },
    async patch(ownerId: string, rawBody: unknown) {
      const body = requestBody(rawBody)
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
    },
    async updateText(ownerId: string, kind: PreferenceTextKind, content: unknown) {
      if (kind !== 'reply-style' && !personalityAvailable)
        throw Object.assign(new Error('用户人格偏好当前未开放'), { statusCode: 403 })
      return updateTextRoute(options, ownerId, kind, normalizeText(content, kind === 'reply-style' ? '回复风格' : '人格偏好'))
    },
  }
}
