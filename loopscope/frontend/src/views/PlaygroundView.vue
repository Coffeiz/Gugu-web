<template>
  <div class="workspace">
    <section class="sessions">
      <header>
        <div><span class="eyebrow">SESSIONS</span><h2>Conversation</h2></div>
        <button class="new" title="新会话" @click="newSession">＋</button>
      </header>
      <div v-if="!connected" class="empty small">从 Gugu <b>/dev</b> 打开 LoopScope 后会自动连接。</div>
      <button
        v-for="s in sessions" :key="s.id"
        class="session-row" :class="{ active: s.id === activeId }"
        @click="selectSession(s.id)"
      >
        <span class="source">{{ s.source || 'web' }}</span>
        <span class="session-title">{{ s.title }}</span>
        <span class="sid">#{{ s.id }}</span>
      </button>
    </section>

    <section class="session-stage">
      <header class="session-head">
        <div>
          <span class="eyebrow">{{ activeId ? `SESSION #${activeId}` : 'NEW SESSION' }}</span>
          <h1>{{ activeSession?.title || 'New conversation' }}</h1>
        </div>
        <div class="head-actions">
          <button v-if="activeId" class="refresh" title="刷新当前会话消息和 Runs" aria-label="刷新当前会话消息和 Runs" @click="refreshAll">↻</button>
          <div v-if="activeId" class="view-switch">
            <button :class="{ active: sessionView === 'conversation' }" @click="showConversation">对话</button>
            <button :class="{ active: sessionView === 'monitor' }" @click="openMonitor">Monitor</button>
          </div>
          <div v-if="sessionView === 'conversation'" class="mode-switch">
            <button :class="{active: mode==='normal'}" @click="mode='normal'">普通</button>
            <button :class="{active: mode==='detail'}" @click="mode='detail'">详细</button>
          </div>
        </div>
      </header>

      <template v-if="sessionView === 'conversation'">
        <div ref="scrollEl" class="messages" @scroll="onMessagesScroll">
          <div v-if="loadingOlder" class="older-loading">正在加载更早消息…</div>
          <div v-if="!messages.length" class="empty">
            <div class="empty-orb">◎</div>
            <strong>从一条真实消息开始</strong>
            <span>消息会走 Gugu 当前 Web AgentLoop；完成后对应 Run 会自动进入 Scope。</span>
          </div>

          <article v-for="(m, idx) in messages" :key="m.id" class="message" :class="m.role">
            <div class="role">{{ m.role === 'user' ? 'YOU' : 'GUGU' }}</div>
            <div class="bubble">{{ m.content }}<span v-if="m.pending" class="typing">▋</span></div>

            <div v-if="mode==='detail' && m.role==='assistant' && (m.debugEvents?.length || runForAssistant(idx))" class="inline-trace">
              <div v-if="m.debugEvents?.length" class="live-debug">
                <div v-for="(evt, eidx) in m.debugEvents" :key="`${m.id}-${eidx}`" class="live-event">
                  <span class="kind" :data-kind="evt.kind">{{ evt.kind }}</span>
                  <span>{{ evt.label }}</span>
                  <span v-if="evt.done" class="done">✓</span>
                  <pre v-if="evt.detail !== undefined">{{ preview(evt.detail) }}</pre>
                </div>
              </div>
              <template v-if="runForAssistant(idx)">
                <div class="trace-summary">
                  <span class="run-state"></span>
                  <b>{{ runForAssistant(idx)?.id }}</b>
                  <span>{{ fmtMs(runForAssistant(idx)?.duration_ms) }}</span>
                  <span>{{ spanCount(runForAssistant(idx), 'llm') }} LLM</span>
                  <span>{{ spanCount(runForAssistant(idx), 'tool') }} tools</span>
                  <span v-if="runForAssistant(idx)?.usage?.input">{{ fmtTokens(runForAssistant(idx)?.usage?.input) }} in</span>
                  <span v-if="runForAssistant(idx)?.usage?.cache_read">{{ fmtTokens(runForAssistant(idx)?.usage?.cache_read) }} cached</span>
                </div>
                <button class="inspect-run" @click="inspectRun(runForAssistant(idx)?.id)">在 Monitor 中查看完整 Run →</button>
              </template>
            </div>
          </article>
        </div>

        <form class="composer ls-card" @submit.prevent="send">
          <textarea v-model="draft" :disabled="sending || !connected" rows="1" placeholder="给咕咕发消息…" @keydown="handleComposerKeydown" />
          <div class="composer-foot">
            <span>{{ mode === 'detail' ? 'Detailed · round / tool / token summary' : 'Normal conversation' }}</span>
            <button class="ls-button primary" :disabled="sending || !draft.trim() || !connected">{{ sending ? 'Running…' : 'Send' }}</button>
          </div>
        </form>
        <p v-if="error" class="error">{{ error }}</p>
      </template>

      <SessionMonitor
        v-else
        ref="monitorRef"
        :runs="runs"
        :details="runDetails"
        :has-more-spans="hasMoreSpans"
        :focus-run-id="monitorFocusRunId"
        @select="loadRunDetail"
        @load-more="loadOlderRuns"
        @load-more-spans="loadMoreSpans"
        @export-runs="exportRuns"
      />
      <p v-if="sessionView === 'monitor' && error" class="error">{{ error }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { ChatMessage, GuguSession, TraceRun } from '../types'
import { listGuguSessions, loadBootstrap, loadMessagePage, sendMessage } from '../services/gugu'
import { getRun, getRunSpans, listRuns } from '../services/api'
import SessionMonitor from '../components/SessionMonitor.vue'

const sessions = ref<GuguSession[]>([])
const activeId = ref<number | null>(null)
const messages = ref<ChatMessage[]>([])
const runs = ref<TraceRun[]>([])
const runDetails = ref<Record<string, TraceRun>>({})
const loadingRunId = ref('')
const loadingSpanRunId = ref('')
const spanOffsets = ref<Record<string, number>>({})
const spanHasMore = ref<Record<string, boolean>>({})
const hasMoreSpans = computed(() => Boolean(spanHasMore.value[monitorFocusRunId.value]))
const hasOlderMessages = ref(false)
const loadingOlder = ref(false)
const oldestMessageId = ref<number | null>(null)
const hasOlderRuns = ref(false)
const loadingOlderRuns = ref(false)
const mode = ref<'normal'|'detail'>('normal')
const sessionView = ref<'conversation'|'monitor'>('conversation')
const monitorFocusRunId = ref('')
const draft = ref('')
const sending = ref(false)
const error = ref('')
const scrollEl = ref<HTMLElement | null>(null)
const monitorRef = ref<{ getScrollTop: () => number; setScrollTop: (value: number) => void } | null>(null)
const conversationScrollTop = ref(0)
const monitorScrollTop = ref(0)
const connected = ref(!!loadBootstrap())
const activeSession = computed(() => sessions.value.find(s => s.id === activeId.value))

async function refreshSessions() {
  if (!connected.value) return
  sessions.value = await listGuguSessions()
}
async function refreshRuns() {
  if (!activeId.value) { runs.value = []; return }
  const source = activeSession.value?.source || 'web'
  runs.value = await listRuns(activeId.value, source, { limit: 20 }).catch(() => [])
  hasOlderRuns.value = runs.value.length >= 20
}
async function loadOlderRuns() {
  if (!activeId.value || !hasOlderRuns.value || loadingOlderRuns.value || !runs.value.length) return
  const oldest = runs.value[0]
  loadingOlderRuns.value = true
  try {
    const source = activeSession.value?.source || 'web'
    const older = await listRuns(activeId.value, source, { limit: 20, before: oldest.started_at })
    const existing = new Set(runs.value.map(run => run.id))
    const unique = older.filter(run => !existing.has(run.id))
    runs.value = [...unique, ...runs.value]
    hasOlderRuns.value = older.length >= 20 && unique.length > 0
  } finally {
    loadingOlderRuns.value = false
  }
}
async function loadRunDetail(runId: string) {
  if (!runId || runDetails.value[runId] || loadingRunId.value === runId) return
  loadingRunId.value = runId
  try {
    const detail = await getRun(runId, { includeSpans: false })
    runDetails.value = { ...runDetails.value, [runId]: detail }
    await loadSpans(runId, 0)
  } finally {
    loadingRunId.value = ''
  }
}
async function loadSpans(runId: string, offset: number) {
  if (loadingSpanRunId.value === runId) return
  loadingSpanRunId.value = runId
  try {
    const page = await getRunSpans(runId, { limit: 100, offset })
    const previous = runDetails.value[runId]
    if (!previous) return
    const current = previous.spans ?? []
    runDetails.value = {
      ...runDetails.value,
      [runId]: { ...previous, spans: offset ? [...current, ...(page.items ?? [])] : (page.items ?? []) },
    }
    spanOffsets.value = { ...spanOffsets.value, [runId]: offset + (page.items?.length ?? 0) }
    spanHasMore.value = { ...spanHasMore.value, [runId]: page.hasMore }
  } finally {
    loadingSpanRunId.value = ''
  }
}
async function loadMoreSpans() {
  const runId = monitorFocusRunId.value
  if (!runId || !hasMoreSpans.value) return
  await loadSpans(runId, spanOffsets.value[runId] ?? 0)
}
async function loadCompleteRun(runId: string): Promise<TraceRun> {
  const detail = await getRun(runId, { includeSpans: false })
  const spans: NonNullable<TraceRun['spans']> = []
  let offset = 0
  while (true) {
    const page = await getRunSpans(runId, { limit: 100, offset })
    spans.push(...(page.items ?? []))
    offset += page.items?.length ?? 0
    if (!page.hasMore || !page.items?.length) break
  }
  return { ...detail, spans }
}
async function exportRuns(runIds: string[]) {
  const ids = [...new Set(runIds)].filter(Boolean)
  if (!ids.length) return
  error.value = ''
  try {
    const exported = await Promise.all(ids.map(loadCompleteRun))
    const payload = {
      format: 'loopscope-run-export',
      version: 1,
      exported_at: new Date().toISOString(),
      runs: exported,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `loopscope-runs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    link.click()
    URL.revokeObjectURL(url)
  } catch (cause) {
    error.value = cause instanceof Error ? `导出失败：${cause.message}` : '导出失败，请稍后重试。'
  }
}
async function loadLatestMessages(sessionId: number) {
  const page = await loadMessagePage(sessionId, { limit: 50 })
  messages.value = page.messages
  hasOlderMessages.value = page.hasMore
  oldestMessageId.value = page.oldestId
}
async function refreshAll() {
  if (!activeId.value) return
  if (messages.value.length && typeof messages.value[messages.value.length - 1].id === 'number') {
    const newestId = Number(messages.value[messages.value.length - 1].id)
    const page = await loadMessagePage(activeId.value, { limit: 50, afterId: newestId })
    const known = new Set(messages.value.map(message => String(message.id)))
    messages.value = [...messages.value, ...page.messages.filter(message => !known.has(String(message.id)))]
  } else {
    await loadLatestMessages(activeId.value)
  }
  await Promise.all([refreshSessions(), refreshRuns()])
  await nextTick()
  scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight })
}
async function selectSession(id: number) {
  activeId.value = id
  conversationScrollTop.value = 0
  monitorScrollTop.value = 0
  runDetails.value = {}
  spanOffsets.value = {}
  spanHasMore.value = {}
  monitorFocusRunId.value = ''
  await loadLatestMessages(id)
  await refreshRuns()
  if (sessionView.value === 'conversation') {
    await nextTick()
    scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight })
  }
}
function newSession() {
  activeId.value = null
  messages.value = []
  runs.value = []
  runDetails.value = {}
  hasOlderRuns.value = false
  hasOlderMessages.value = false
  oldestMessageId.value = null
  draft.value = ''
  sessionView.value = 'conversation'
  monitorFocusRunId.value = ''
  conversationScrollTop.value = 0
  monitorScrollTop.value = 0
}
async function showConversation() {
  if (sessionView.value === 'monitor') monitorScrollTop.value = monitorRef.value?.getScrollTop() ?? 0
  sessionView.value = 'conversation'
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = conversationScrollTop.value
}
async function openMonitor() {
  if (!activeId.value) return
  conversationScrollTop.value = scrollEl.value?.scrollTop ?? conversationScrollTop.value
  await refreshRuns()
  if (!runs.value.some(run => run.id === monitorFocusRunId.value)) {
    monitorFocusRunId.value = runs.value[runs.value.length - 1]?.id ?? ''
  }
  if (monitorFocusRunId.value) await loadRunDetail(monitorFocusRunId.value)
  sessionView.value = 'monitor'
  await nextTick()
  monitorRef.value?.setScrollTop(monitorScrollTop.value)
}
function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return
  // 输入法确认候选词也会发 Enter；组合输入期间交给 IME，不能提交表单。
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void send()
}
function inspectRun(runId?: string) {
  if (!runId) return
  monitorFocusRunId.value = runId
  void loadRunDetail(runId)
  void openMonitor()
}
async function onMessagesScroll() {
  const el = scrollEl.value
  if (!el || el.scrollTop > 80 || !hasOlderMessages.value || loadingOlder.value || !activeId.value || oldestMessageId.value == null) return
  const previousHeight = el.scrollHeight
  const previousTop = el.scrollTop
  loadingOlder.value = true
  try {
    const page = await loadMessagePage(activeId.value, { limit: 50, beforeId: oldestMessageId.value })
    messages.value = [...page.messages, ...messages.value]
    hasOlderMessages.value = page.hasMore
    oldestMessageId.value = page.oldestId ?? oldestMessageId.value
    await nextTick()
    el.scrollTop = el.scrollHeight - previousHeight + previousTop
  } finally {
    loadingOlder.value = false
  }
}
async function send() {
  const text = draft.value.trim()
  if (!text || sending.value) return
  error.value = ''
  sending.value = true
  draft.value = ''
  const user: ChatMessage = { id: `u-${Date.now()}`, role:'user', content:text }
  const ai: ChatMessage = {
    id: `a-${Date.now()}`, role:'assistant', content:'', pending:true,
    debugEvents: [{ kind:'status', label:'Agent loop started' }],
  }
  messages.value.push(user, ai)
  await nextTick()
  scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight, behavior:'smooth' })
  try {
    const sid = await sendMessage(text, activeId.value, evt => {
      if (evt.type === 'session_id') activeId.value = Number(evt.session_id)
      else if (evt.type === 'token') {
        ai.content += evt.content ?? ''
        if (!ai.debugEvents?.some(x => x.label === 'Final response streaming')) {
          ai.debugEvents?.push({ kind:'status', label:'Final response streaming' })
        }
      } else if (evt.type === 'tool_call') {
        ai.debugEvents?.push({ kind:'tool', label: evt.label || evt.name || 'tool call', detail: evt.input })
      } else if (evt.type === 'tool_done') {
        const active = [...(ai.debugEvents ?? [])].reverse().find(x => x.kind === 'tool' && !x.done)
        if (active) active.done = true
      } else if (evt.type === '_new_round') {
        ai.debugEvents?.push({ kind:'round', label:'Agent continues to next model round' })
      } else if (evt.type === 'error') {
        ai.content += evt.message || evt.detail || 'Agent error'
      }
      nextTick(() => scrollEl.value?.scrollTo({ top: scrollEl.value!.scrollHeight }))
    })
    if (sid) activeId.value = sid
    ai.pending = false
    await refreshSessions()
    const before = runs.value.length
    for (let i = 0; i < 6; i += 1) {
      await new Promise(r => setTimeout(r, 160))
      await refreshRuns()
      if (runs.value.length > before) break
    }
    ai.runId = runs.value[runs.value.length - 1]?.id
    if (ai.runId) void loadRunDetail(ai.runId)
  } catch (e: any) {
    ai.pending = false
    error.value = e?.message ?? String(e)
  } finally {
    sending.value = false
  }
}
function assistantOrdinal(messageIndex: number) {
  return messages.value.slice(0, messageIndex + 1).filter(m => m.role === 'assistant').length - 1
}
function runForAssistant(messageIndex: number) {
  const message = messages.value[messageIndex]
  if (message?.runId) return runDetails.value[message.runId] ?? runs.value.find(r => r.id === message.runId)
  const assistantCount = messages.value.filter(m => m.role === 'assistant').length
  const offset = Math.max(0, assistantCount - runs.value.length)
  const ordinal = assistantOrdinal(messageIndex) - offset
  return ordinal >= 0 ? runs.value[ordinal] : undefined
}
function spanCount(run: TraceRun | undefined, kind: string) { return run?.spans?.filter(s => s.kind === kind).length ?? 0 }
function fmtMs(v: number | null | undefined) { return v == null ? '—' : v >= 1000 ? `${(v/1000).toFixed(2)}s` : `${Math.round(v)}ms` }
function fmtTokens(v: number | null | undefined) { return v == null ? '—' : v >= 1000 ? `${(v/1000).toFixed(v >= 10000 ? 1 : 2)}k` : String(Math.round(v)) }
function preview(v: unknown) {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  return (s || '').slice(0, 700)
}
async function onBootstrap() {
  connected.value = !!loadBootstrap()
  await refreshSessions()
  if (!activeId.value && sessions.value[0]) await selectSession(sessions.value[0].id)
}
onMounted(async () => {
  window.addEventListener('loopscope:bootstrap', onBootstrap)
  await onBootstrap()
})
onUnmounted(() => window.removeEventListener('loopscope:bootstrap', onBootstrap))
</script>

<style scoped>
.workspace { height:100vh; min-height:0; display:grid; grid-template-columns:250px minmax(0,1fr); overflow:hidden; }
.sessions { min-height:0; overflow-y:auto; overflow-x:hidden; border-right:1px solid var(--border-subtle); padding:24px 14px; background:rgba(255,255,255,.34); }
.sessions header,.session-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
h1,h2 { margin:3px 0 0; font-size:18px; }
.eyebrow { font-size:10px; letter-spacing:.11em; color:var(--content-tertiary); font-weight:600; }
.new { border:0; background:var(--action-soft); color:var(--action-primary); border-radius:10px; width:32px; height:32px; }
.session-row { width:100%; margin-top:8px; display:grid; grid-template-columns:auto 1fr auto; gap:8px; align-items:center; text-align:left; border:1px solid transparent; background:transparent; border-radius:12px; padding:10px; color:var(--content-secondary); }
.session-row:hover { background:var(--surface-card); }
.session-row.active { background:var(--surface-raised); border-color:var(--border-subtle); box-shadow:var(--elevation-card); color:var(--content-primary); }
.source,.sid { font-size:10px; color:var(--content-tertiary); font-family:var(--font-mono); }
.source { padding:3px 5px; background:var(--surface-soft); border-radius:5px; }
.session-title { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:12px; }
.session-stage { min-width:0; min-height:0; height:100%; display:grid; grid-template-rows:auto minmax(0,1fr) auto auto; overflow:hidden; }
.session-head { padding:20px 28px 14px; border-bottom:1px solid var(--border-subtle); }
.head-actions { display:flex; align-items:center; gap:8px; }
.refresh { width:30px; height:30px; border:1px solid var(--border-subtle); border-radius:9px; background:var(--surface-raised); color:var(--content-secondary); font-size:17px; line-height:1; }
.refresh:hover { border-color:var(--border-default); color:var(--content-primary); box-shadow:var(--elevation-card); }
.refresh:focus-visible { outline:3px solid var(--focus-ring); outline-offset:1px; }
.view-switch,.mode-switch { display:flex; background:var(--surface-soft); border-radius:10px; padding:3px; }
.view-switch button,.mode-switch button { border:0; background:transparent; padding:6px 9px; border-radius:8px; color:var(--content-secondary); font-size:11px; }
.view-switch button.active,.mode-switch button.active { background:var(--surface-raised); color:var(--content-primary); box-shadow:var(--elevation-card); }
.messages { min-height:0; overflow:auto; padding:28px max(28px, calc((100% - 780px)/2)); }
.older-loading { margin:-14px auto 16px; width:max-content; color:var(--content-tertiary); font-size:10px; }
.message { max-width:720px; margin:0 auto 24px; }
.role { font-size:9px; letter-spacing:.12em; color:var(--content-tertiary); margin-bottom:6px; }
.message.user .bubble { margin-left:auto; background:var(--action-soft); }
.bubble { width:fit-content; max-width:85%; white-space:pre-wrap; line-height:1.7; padding:11px 14px; border-radius:15px; background:var(--surface-raised); border:1px solid var(--border-subtle); box-shadow:var(--elevation-card); }
.typing { opacity:.45; animation:blink 1s infinite; }
@keyframes blink { 50% { opacity:0; } }
.inline-trace { margin-top:8px; border-left:2px solid var(--trace-llm); padding:7px 0 2px 10px; font-size:11px; color:var(--content-secondary); }
.trace-summary { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.run-state { width:6px; height:6px; border-radius:50%; background:var(--status-success); }
.inspect-run { margin-top:7px; border:0; padding:0; background:transparent; color:var(--action-primary); font-size:10px; }
.kind { font:9px var(--font-mono); text-transform:uppercase; color:var(--content-tertiary); }
.composer { margin:0 max(28px, calc((100% - 780px)/2)) 22px; padding:10px; }
.composer textarea { width:100%; border:0; outline:0; resize:none; background:transparent; min-height:44px; color:var(--content-primary); }
.composer-foot { display:flex; justify-content:space-between; align-items:center; gap:12px; font-size:10px; color:var(--content-tertiary); }
.live-debug { display:grid; gap:6px; margin-bottom:8px; }
.live-event { display:grid; grid-template-columns:58px minmax(0,1fr) auto; gap:8px; align-items:start; font-size:10px; color:var(--content-secondary); }
.live-event .kind { text-transform:uppercase; font:9px var(--font-mono); color:var(--content-tertiary); }
.live-event .done { color:var(--status-success); }
.live-event pre { grid-column:2/-1; margin:2px 0 0; padding:7px 8px; max-height:120px; overflow:auto; white-space:pre-wrap; background:var(--surface-soft); border-radius:var(--radius-xs); font-size:9px; }
.error { margin:0 28px 14px; color:var(--status-danger); font-size:11px; }
.empty { margin:auto; min-height:240px; display:grid; place-items:center; align-content:center; gap:8px; color:var(--content-secondary); text-align:center; }
.empty.small { min-height:90px; font-size:11px; padding:12px; }
.empty-orb { font-size:36px; color:var(--iris-500); }
.empty span { max-width:360px; font-size:12px; }
@media(max-width:900px){ .workspace{grid-template-columns:190px 1fr;} }
</style>
