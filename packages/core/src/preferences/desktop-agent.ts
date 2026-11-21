import { CoreError } from '../contracts/index.js'
import { object, onlyFields } from '../shared/values.js'
import type { DesktopAgentPreference } from '../contracts/desktop.js'
import { createPreferenceService, type PreferenceDocumentStore, type PreferenceTextFiles } from './service.js'

const fields = {
  personality: ['personalityPreference', 'personalityPreferenceEnabled'],
  'group-personality': ['groupPersonalityPreference', 'groupPersonalityPreferenceEnabled'],
  'reply-style': ['customReplyStyle', 'customReplyStyleEnabled'],
} as const

export async function desktopAgentPreference(store: PreferenceDocumentStore, files: PreferenceTextFiles,
  owner: string, kind: unknown, rawPatch?: unknown): Promise<DesktopAgentPreference> {
  if (typeof kind !== 'string' || !Object.hasOwn(fields, kind))
    throw new CoreError('invalid_request', '人格偏好类型无效')
  const [contentKey, enabledKey] = fields[kind as keyof typeof fields]
  const service = createPreferenceService({ store, textFiles: files, personalityPreferenceAvailable: true })
  let data: Record<string, unknown>
  if (rawPatch === undefined) {
    data = await service.get(owner)
  } else {
    object(rawPatch)
    onlyFields(rawPatch, ['content', 'enabled'])
    const { content, enabled } = rawPatch
    if (enabled !== undefined && typeof enabled !== 'boolean')
      throw new CoreError('invalid_request', '人格偏好开关无效')
    if (content !== undefined && content !== null && typeof content !== 'string')
      throw new CoreError('invalid_request', '人格偏好正文无效')
    if (kind === 'reply-style' && content !== undefined) {
      if (enabled !== undefined) throw new CoreError('invalid_request', '请分别更新回复风格正文和开关')
      data = await service.updateText(owner, kind, content)
    } else {
      data = await service.patch(owner, {
        ...(content === undefined ? {} : { [contentKey]: content }),
        ...(enabled === undefined ? {} : { [enabledKey]: enabled }),
      })
    }
  }
  const content = data[contentKey]
  return {
    content: typeof content === 'string' ? content : null,
    enabled: data[enabledKey] === true,
    revision: Number(data.personalityPreferenceRevision ?? 0),
  }
}
