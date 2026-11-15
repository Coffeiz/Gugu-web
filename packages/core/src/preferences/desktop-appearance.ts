import { CoreError } from '../contracts/index.js'
import {
  normalizePreferenceResponse,
  parsePreferencePatch,
  parsePreferenceRequest,
  readPreferenceDocument,
} from './general.js'
import type { PreferenceDocumentStore } from './service.js'

const DESKTOP_APPEARANCE_FIELDS = new Set(['theme', 'themeFamily', 'palette'])

/** 桌面仅开放本地外观设置，避免通用偏好读取触发旧文本文件迁移。 */
export function createDesktopAppearanceService(store: PreferenceDocumentStore) {
  async function get(ownerId: string) {
    const data = readPreferenceDocument(await store.read(ownerId))
    const normalized = normalizePreferenceResponse(data, {
      replyStyle: null,
      personality: null,
      groupPersonality: null,
    }, false)
    return {
      theme: normalized.theme,
      themeFamily: normalized.themeFamily,
      palette: normalized.palette,
    }
  }
  return {
    get,
    async update(ownerId: string, rawBody: unknown) {
      const body = parsePreferenceRequest(rawBody)
      const unsupported = Object.keys(body).find((key) => !DESKTOP_APPEARANCE_FIELDS.has(key))
      if (unsupported) throw new CoreError('invalid_request', '桌面外观设置字段无效')
      const patch = parsePreferencePatch(body)
      const current = readPreferenceDocument(await store.read(ownerId))
      await store.write(ownerId, { ...current, ...patch })
      return get(ownerId)
    },
  }
}
