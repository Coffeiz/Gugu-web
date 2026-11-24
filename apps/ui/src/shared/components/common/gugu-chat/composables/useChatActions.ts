import { decodeMindFileReference, folderLinkReference } from '@/composables/mind/fileReference'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { useFileOpenAccess } from '@/services/fileOpenAccess'
import { useProjectStore } from '@/stores/projects'
import { useLiveStore } from '@/stores/live'
import { useUiStore } from '@/stores/ui'
import { uploadSignal, calendarSignal } from '@/services/cache'
import type { Router } from 'vue-router'
import { i18n } from '@/i18n'
import { notifyResourceChanged } from '@/services/resourceRefreshEvents'
import { useMindRefActions } from '@/composables/mind/useMindRefActions'
import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { copyTextToClipboard } from './copyTextToClipboard'
import { downloadMarkdownMathPng, toggleMarkdownMathSource } from '@/utils/chart/math'

// 工具名 → 受影响数据域，咕咕操作后据此刷新前端，免手动刷新页面。
// 与后端 RESOURCE_BY_TOOL（app/core/events.py）保持一致——漏了哪个工具，对应视图就不会实时刷新。
// consumeStream() 的 tool_done 分支也要按同一份集合即时 bump 对应资源，故导出。
export const PROJECT_TOOLS = new Set(['create_project','update_project','delete_project','archive_project','update_stage','set_priority','set_color','add_stage','remove_stage','rename_stage','set_stages'])
export const CALENDAR_TOOLS = new Set(['create_event','update_event','delete_event'])
export const FILE_TOOLS = new Set(['edit_file','create_file','rename_file','move_items','copy_file','create_folder','delete_file','rename_folder','delete_folder','save_attachment','restore_file','permanent_delete'])
export const MIND_WRITE_TOOLS = new Set([
  'note_create', 'note_update', 'note_delete', 'note_restore', 'note_undo',
  'canvas_create', 'canvas_delete', 'canvas_create_note', 'canvas_update_note', 'canvas_delete_note',
  'canvas_add_node', 'canvas_update_node', 'canvas_remove_node',
  'canvas_connect', 'canvas_update_anchor', 'canvas_disconnect', 'canvas_batch',
])
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
  onOpenSkill: (skillId: string) => void
}) {
  const projectStore = useProjectStore()
  const liveStore = useLiveStore()
  const uiStore = useUiStore()
  const { openMindRef } = useMindRefActions()
  const pathFiles = usePathFileAccess()
  const desktopFileOpen = useFileOpenAccess()

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

  async function onChatActionClick(e: MouseEvent) {
    // 代码块「复制」按钮：渲染时不写内联 onclick（DOMPurify 会剥掉 on*），这里事件委托兜住
    const target = e.target as HTMLElement
    const mathDownloadButton = target.closest?.('.md-math-download-btn') as HTMLButtonElement | null
    if (mathDownloadButton) {
      e.preventDefault()
      const formula = mathDownloadButton.closest('.md-math-block')?.querySelector<HTMLElement>('.md-math-result')
        ?? mathDownloadButton.closest('.md-math-copy-wrap')?.querySelector<HTMLElement>('.katex')
      if (!formula) return
      try {
        await downloadMarkdownMathPng(formula)
      } catch (error) {
        const key = error instanceof Error && error.message === 'png_too_large'
          ? 'mermaidUi.formulaPngTooLarge' : 'mermaidUi.formulaDownloadFailed'
        showAppError(i18n.global.t(key))
      }
      return
    }
    const mathSourceButton = target.closest?.('.md-math-source-toggle-btn') as HTMLButtonElement | null
    if (mathSourceButton) {
      e.preventDefault()
      toggleMarkdownMathSource(mathSourceButton)
      return
    }
    const mathButton = target.closest?.('.md-math-copy-btn') as HTMLButtonElement | null
    if (mathButton) {
      e.preventDefault()
      const source = mathButton.dataset.mathSource || ''
      if (!source) return
      const copied = await copyTextToClipboard(source)
      if (!copied) {
        showAppError(i18n.global.t('chatUi.copyFailed'))
        return
      }
      const originalIcon = mathButton.innerHTML
      const copiedLabel = mathButton.dataset.copiedLabel || i18n.global.t('chatUi.copied')
      mathButton.textContent = '✓'
      mathButton.title = copiedLabel
      mathButton.setAttribute('aria-label', copiedLabel)
      setTimeout(() => {
        mathButton.innerHTML = originalIcon
        mathButton.title = mathButton.dataset.copyLabel || i18n.global.t('chatUi.copy')
        mathButton.setAttribute('aria-label', mathButton.title)
      }, 1200)
      return
    }
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
    const a = target.closest?.('a[href^="gugu://" i]') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') || ''
    if (href.startsWith('gugu://download-file/')) {
      const reference = href.slice('gugu://download-file/'.length)
      const file = decodeMindFileReference(reference)
      const card = a.previousElementSibling
      if (!desktopFileOpen && file && a.classList.contains('chat-file-card-download')
        && card?.classList.contains('chat-object-card')
        && card.getAttribute('href') === 'gugu://open-object/file/' + reference) {
        try { await pathFiles.download(file) }
        catch (error) { showAppError(errorMessage(error)) }
      }
      return
    }
    const mBind = href.match(/^gugu:\/\/bind-im\/([a-z]+)/i)
    if (mBind) { options.onBindPlatform(mBind[1]); return }
    const folderLink = folderLinkReference(href)
    if (folderLink) {
      if (!await openMindRef('folder', folderLink)) showAppNotice(i18n.global.t('mindUi.referenceMissing'))
      return
    }
    const fileLink = /^gugu:\/\/open-object\/file\/((?:path|drop)-[A-Za-z0-9_-]{1,24000})$/u.exec(href)
    if (fileLink) {
      try {
        if (!await openMindRef('file', fileLink[1]!, { revealUnsupportedFile: true }))
          showAppNotice(i18n.global.t('mindUi.referenceMissing'))
      } catch (error) { showAppError(errorMessage(error)) }
      return
    }
    if (/^gugu:\/\/(?:open-file|open-object\/file)\//i.test(href)) {
      showAppNotice(i18n.global.t('mindUi.referenceMissing'))
      return
    }
    const mCanvasFocus = href.match(/^gugu:\/\/focus-canvas\/(\d+)\/(\d+)$/i)
    if (mCanvasFocus) {
      uiStore.pendingCanvasTarget = { canvasId: Number(mCanvasFocus[1]), nodeId: Number(mCanvasFocus[2]) }
      await options.router.push('/canvases')
      return
    }
    const mObject = href.match(/^gugu:\/\/open-object\/(project|event|canvas|note|scheduled-task)\/(\d+)$/i)
    if (mObject) options.onOpenObject(mObject[1].toLowerCase(), Number(mObject[2]))
    const mSkill = href.match(/^gugu:\/\/open-skill\/(U[1-9][0-9]*)$/i)
    if (mSkill) options.onOpenSkill(mSkill[1].toUpperCase())
  }

  return { refreshAfterTools, onChatActionClick }
}
