import { useProjectStore } from '@/stores/projects'
import { useLiveStore } from '@/stores/live'
import { useUiStore } from '@/stores/ui'
import { uploadSignal, calendarSignal } from '@/services/cache'
import type { Router } from 'vue-router'
import { i18n } from '@/i18n'

// 工具名 → 受影响数据域，咕咕操作后据此刷新前端，免手动刷新页面。
// 与后端 RESOURCE_BY_TOOL（app/core/events.py）保持一致——漏了哪个工具，对应视图就不会实时刷新。
// consumeStream() 的 tool_done 分支也要按同一份集合即时 bump 对应资源，故导出。
export const PROJECT_TOOLS = new Set(['create_project','update_project','delete_project','archive_project','update_stage','set_priority','set_color','add_stage','remove_stage','rename_stage','add_todo','remove_todo','set_stages','update_todo'])
export const CALENDAR_TOOLS = new Set(['create_event','update_event','delete_event'])
export const FILE_TOOLS = new Set(['edit_file','create_document','rename_file','move_items','copy_file','create_folder','delete_file','rename_folder','delete_folder','save_uploaded_file','restore_file','permanent_delete'])

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
    } catch (e) { /* 刷新失败不影响对话 */ }
  }

  function onChatActionClick(e: MouseEvent) {
    // 代码块「复制」按钮：渲染时不写内联 onclick（DOMPurify 会剥掉 on*），这里事件委托兜住
    const target = e.target as HTMLElement
    const btn = target.closest?.('.md-copy-btn') as HTMLElement | null
    if (btn) {
      e.preventDefault()
      const text = (btn.closest('.md-code-block')?.querySelector('code') as HTMLElement | null)?.innerText ?? ''
      const done = () => { btn.textContent = `${i18n.global.t('chatUi.copied')} ✓`; setTimeout(() => { btn.textContent = i18n.global.t('chatUi.copy') }, 1200) }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done)
      } else {
        const a = document.createElement('textarea')
        a.value = text; a.style.position = 'fixed'; a.style.opacity = '0'
        document.body.appendChild(a); a.select()
        try { document.execCommand('copy') } catch {}
        a.remove(); done()
      }
      return
    }
    const a = target.closest?.('a[href^="gugu://"]') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') || ''
    const mBind = href.match(/^gugu:\/\/bind-im\/([a-z]+)/i)
    if (mBind) { options.onBindPlatform(mBind[1]); return }
    const mFile = href.match(/^gugu:\/\/open-file\/(\d+)/i)
    if (mFile) {
      uiStore.pendingFileTarget = { kind: 'file', id: parseInt(mFile[1]) }
      options.router.push('/files')
      return
    }
    const mObject = href.match(/^gugu:\/\/open-object\/(project|event|canvas|note|scheduled-task)\/(\d+)$/i)
    if (mObject) options.onOpenObject(mObject[1].toLowerCase(), Number(mObject[2]))
    const mSkill = href.match(/^gugu:\/\/open-skill\/([a-z0-9][a-z0-9-]{0,79})$/i)
    if (mSkill) options.onOpenSkill(mSkill[1].toLowerCase())
  }

  return { refreshAfterTools, onChatActionClick }
}
