import { useProjectStore } from '@/stores/projects'
import { useLiveStore } from '@/stores/live'
import { useUiStore } from '@/stores/ui'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import { usePreviewBlobCache } from '@/composables/shared/usePreviewBlobCache'
import { filesApi } from '@/services/api'
import { uploadSignal, calendarSignal } from '@/services/cache'
import type { Router } from 'vue-router'
import { i18n } from '@/i18n'
import { notifyResourceChanged } from '@/services/resourceRefreshEvents'
import { showAppError } from '@/composables/core/useAppToast'
import { copyTextToClipboard } from './copyTextToClipboard'

// 工具名 → 受影响数据域，咕咕操作后据此刷新前端，免手动刷新页面。
// 与后端 RESOURCE_BY_TOOL（app/core/events.py）保持一致——漏了哪个工具，对应视图就不会实时刷新。
// consumeStream() 的 tool_done 分支也要按同一份集合即时 bump 对应资源，故导出。
export const PROJECT_TOOLS = new Set(['create_project','update_project','delete_project','archive_project','update_stage','set_priority','set_color','add_stage','remove_stage','rename_stage','set_stages'])
export const CALENDAR_TOOLS = new Set(['create_event','update_event','delete_event'])
export const FILE_TOOLS = new Set(['edit_file','create_file','rename_file','move_items','copy_file','create_folder','delete_file','rename_folder','delete_folder','save_uploaded_file','restore_file','permanent_delete'])
export const SCHEDULED_TASK_TOOLS = new Set(['create_scheduled_task', 'update_scheduled_task', 'delete_scheduled_task'])
export const SKILL_TOOLS = new Set(['create_skill', 'update_skill', 'delete_skill'])
export const MCP_TOOLS = new Set(['manage_mcp_servers'])

/**
 * gugu:// 协议链接（代码块复制、绑定 IM、打开文件）+ 工具完成后的前端刷新通知。
 * 不拥有消息数据或流式状态，只对外提供两个函数，由 GuguChat.vue 在 onChatActionClick/
 * consumeStream 收尾处调用。
 */
export function useChatActions(options: {
  router: Router
  onBindPlatform: (platform: string) => void
  onOpenObject: (type: string, id: number) => void
  onOpenSkill: (slug: string) => void
}) {
  const projectStore = useProjectStore()
  const liveStore = useLiveStore()
  const uiStore = useUiStore()

  async function refreshAfterTools(usedTools: Set<string>) {
    if (!usedTools.size) return
    const has = (set: Set<string>) => [...usedTools].some(t => set.has(t))
    try {
      if (has(PROJECT_TOOLS)) await projectStore.fetchProjects()
      if (has(CALENDAR_TOOLS)) { calendarSignal.value++; projectStore.fetchUpcomingCalEvents?.() }
      // 文件：刷文件管理器（uploadSignal）+ 确定性 bump rev.files 让打开的预览窗重载。
      // 实时 SSE（live.js）是 best-effort（dev 重启 / pub-sub 竞态会丢事件），靠这条回合末兜底保证稳定刷新。
      if (has(FILE_TOOLS)) { uploadSignal.value++; liveStore.bump('files') }
      // 定时任务没有独立的全局 store；通过 live rev 触发打开中的定时任务面板重拉。
      // 这条回合末兜底也覆盖当前标签页的 SSE 回声被视为 own event 的情况：咕咕工具
      // 没有更新页面上的本地草稿，不能沿用“自己已乐观更新所以跳过重拉”的规则。
      if (has(SCHEDULED_TASK_TOOLS)) {
        liveStore.bump('scheduled_tasks')
        notifyResourceChanged('scheduledTasks')
      }
      // 技能和 MCP 没有 live 资源 revision；聊天工具完成后通过同一套页面事件
      // 通知已打开的管理页重新读取，避免必须手动刷新浏览器。
      if (has(SKILL_TOOLS)) notifyResourceChanged('skills')
      if (has(MCP_TOOLS)) notifyResourceChanged('mcp')
    } catch (e) { /* 刷新失败不影响对话 */ }
  }

  // 咕咕文件链接统一处理：能预览就直接开预览窗（与附件胶囊一致）；
  // 预览不了（非白名单类型/已删除）才退回跳文件库定位。
  // 咕咕实际会发两种格式：gugu://open-file/<id> 和 gugu://open-object/file/<id>，都接。
  async function openFileFromLink(id: number) {
    const previewStore = usePreviewStore()
    const previewBlobCache = usePreviewBlobCache()
    const existing = previewStore.windows.find(win => win.file.id === id)?.file
      ?? (previewStore.singleFile?.id === id ? previewStore.singleFile : null)
    if (existing) {
      previewStore.open(existing)
      return
    }

    // 同一页面内重开时先命中正文缓存，避免为了签名地址再等待一次服务器请求。
    const cachedFile = previewBlobCache.getFile(id, liveStore.rev.files)
    if (cachedFile && previewBlobCache.get(previewBlobCache.keyOf(cachedFile))) {
      previewStore.open(cachedFile)
      return
    }

    let f: Awaited<ReturnType<typeof filesApi.getStreamUrl>>['file'] | null = null
    let streamUrl: string | undefined
    try {
      const result = await filesApi.getStreamUrl(id)
      f = result.file
      streamUrl = result.url
      previewBlobCache.rememberFile(f, liveStore.rev.files)
    } catch {
      // 与文件已删除或无法预览时一致，交由文件库展示定位结果。
    }
    if (f && isPreviewable(f.ext, f.mimeType)) {
      previewStore.open(f, null, false, streamUrl)
      return
    }
    uiStore.pendingFileTarget = { kind: 'file', id }
    options.router.push('/files')
  }

  async function onChatActionClick(e: MouseEvent) {
    // 代码块「复制」按钮：渲染时不写内联 onclick（DOMPurify 会剥掉 on*），这里事件委托兜住
    const target = e.target as HTMLElement
    const btn = target.closest?.('.md-copy-btn') as HTMLElement | null
    if (btn) {
      e.preventDefault()
      const text = (btn.closest('.md-code-block')?.querySelector('code') as HTMLElement | null)?.innerText ?? ''
      const copied = await copyTextToClipboard(text)
      if (!copied) {
        showAppError(i18n.global.t('chatUi.copyFailed'))
        return
      }
      btn.textContent = `${i18n.global.t('chatUi.copied')} ✓`
      setTimeout(() => { btn.textContent = i18n.global.t('chatUi.copy') }, 1200)
      return
    }
    const a = target.closest?.('a[href^="gugu://"]') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') || ''
    const mBind = href.match(/^gugu:\/\/bind-im\/([a-z]+)/i)
    if (mBind) { options.onBindPlatform(mBind[1]); return }
    const mFile = href.match(/^gugu:\/\/open-file\/(\d+)/i) || href.match(/^gugu:\/\/open-object\/file\/(\d+)$/i)
    if (mFile) {
      await openFileFromLink(parseInt(mFile[1]))
      return
    }
    const mObject = href.match(/^gugu:\/\/open-object\/(project|event|canvas|note|scheduled-task)\/(\d+)$/i)
    if (mObject) options.onOpenObject(mObject[1].toLowerCase(), Number(mObject[2]))
    const mSkill = href.match(/^gugu:\/\/open-skill\/([a-z0-9][a-z0-9-]{0,79})$/i)
    if (mSkill) options.onOpenSkill(mSkill[1].toLowerCase())
  }

  return { refreshAfterTools, onChatActionClick }
}
