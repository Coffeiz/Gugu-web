import { isValidTimezone } from '../shared/date-time.js'
import { CoreError } from '../contracts/index.js'
import {
  normalizePreferenceResponse,
  normalizePreferenceText,
  parsePreferencePatch,
  parsePreferenceRequest,
  readPreferenceDocument,
} from './general.js'
import type { PreferenceDocumentStore } from './service.js'

const DESKTOP_APPEARANCE_FIELDS = new Set(['theme', 'themeFamily', 'palette', 'useSystemProxy', 'fileOpenPreference', 'automaticModeEnabled', 'imToolDisplayMode', 'showIntermediateReplies', 'decisionGuardEnabled', 'toolInjectionMode', 'customReplyStyle', 'customReplyStyleEnabled', 'timezone', 'locale', 'defaultView', 'calendarWeekStart', 'calendarDoneMode', 'projectSort'])

/** 桌面读取本机偏好，避免触发旧文本文件迁移。 */
export function createDesktopAppearanceService(store: PreferenceDocumentStore) {
  async function get(ownerId: string) {
    const data = readPreferenceDocument(await store.read(ownerId))
    const normalized = normalizePreferenceResponse(data, {
      replyStyle: normalizePreferenceText(data.custom_reply_style, '回复风格'),
      personality: null,
      groupPersonality: null,
    }, false)
    return {
      timezone: typeof data.timezone === 'string' && isValidTimezone(data.timezone) ? data.timezone : null,
      locale: normalized.locale,
      defaultView: normalized.defaultView,
      calendarWeekStart: normalized.calendarWeekStart,
      calendarDoneMode: data.calendarDoneMode === 'deadline' ? 'deadline' as const : 'done' as const,
      projectSort: data.projectSort === 'name' || data.projectSort === 'deadline' ? data.projectSort : 'default' as const,
      theme: normalized.theme,
      themeFamily: normalized.themeFamily,
      palette: normalized.palette,
      toolInjectionMode: normalized.toolInjectionMode === 'full' ? 'full' as const : 'description' as const,
      customReplyStyle: typeof normalized.customReplyStyle === 'string' ? normalized.customReplyStyle : null,
      customReplyStyleEnabled: normalized.customReplyStyleEnabled === true,
      decisionGuardEnabled: normalized.decisionGuardEnabled === true,
      imToolDisplayMode: normalized.imToolDisplayMode,
      showIntermediateReplies: normalized.showIntermediateReplies,
      useSystemProxy: data.useSystemProxy === true,
      ...(data.fileOpenPreference === 'system' || data.fileOpenPreference === 'preview'
        ? { fileOpenPreference: data.fileOpenPreference } : {}),
      ...(typeof data.automatic_mode_enabled === 'boolean' ? { automaticModeEnabled: normalized.automaticModeEnabled } : {}),
    }
  }
  return {
    get,
    async update(ownerId: string, rawBody: unknown) {
      const body = parsePreferenceRequest(rawBody)
      const unsupported = Object.keys(body).find((key) => !DESKTOP_APPEARANCE_FIELDS.has(key))
      if (unsupported) throw new CoreError('invalid_request', '桌面外观设置字段无效')
      const { useSystemProxy, timezone, customReplyStyle, fileOpenPreference, calendarDoneMode, projectSort, ...appearance } = body
      if (calendarDoneMode !== undefined && calendarDoneMode !== 'done' && calendarDoneMode !== 'deadline')
        throw new CoreError('invalid_request', '已完成项目显示方式无效')
      if (projectSort !== undefined && projectSort !== 'default' && projectSort !== 'name' && projectSort !== 'deadline')
        throw new CoreError('invalid_request', '项目排序方式无效')
      if (appearance.defaultView !== undefined && (typeof appearance.defaultView !== 'string' || !['projects', 'calendar', 'files', 'mind'].includes(appearance.defaultView)))
        throw new CoreError('invalid_request', '默认视图无效')
      if (appearance.calendarWeekStart !== undefined && appearance.calendarWeekStart !== 'monday' && appearance.calendarWeekStart !== 'sunday')
        throw new CoreError('invalid_request', '一周起始日无效')
      if (fileOpenPreference !== undefined && fileOpenPreference !== 'system' && fileOpenPreference !== 'preview')
        throw new CoreError('invalid_request', '文件打开方式无效')
      if (useSystemProxy !== undefined && typeof useSystemProxy !== 'boolean')
        throw new CoreError('invalid_request', '系统代理设置无效')
      if (timezone !== undefined && timezone !== null && (typeof timezone !== 'string' || !isValidTimezone(timezone)))
        throw new CoreError('invalid_request', '时区设置无效')
      const patch = parsePreferencePatch(appearance)
      if (calendarDoneMode !== undefined) patch.calendarDoneMode = calendarDoneMode
      if (projectSort !== undefined) patch.projectSort = projectSort
      if (customReplyStyle !== undefined) patch.custom_reply_style = normalizePreferenceText(customReplyStyle, '回复风格')
      const current = readPreferenceDocument(await store.read(ownerId))
      await store.write(ownerId, { ...current, ...patch, ...(timezone === undefined ? {} : { timezone }), ...(useSystemProxy === undefined ? {} : { useSystemProxy }), ...(fileOpenPreference === undefined ? {} : { fileOpenPreference }) })
      return get(ownerId)
    },
  }
}
