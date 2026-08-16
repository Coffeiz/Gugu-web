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

    <section class="conversation">
      <header class="conversation-head">
        <div>
          <span class="eyebrow">{{ activeId ? `SESSION #${activeId}` : 'NEW SESSION' }}</span>
          <h1>{{ activeSession?.title || 'New conversation' }}</h1>
        </div>
        <div class="head-actions">
          <div class="mode-switch">
            <button :class="{active: mode==='normal'}" @click="mode='normal'">普通</button>
            <button :class="{active: mode==='detail'}" @click="mode='detail'">详细</button>
          </div>
          <RouterLink v-if="activeId" class="ls-button monitor-link" :to="`/sessions/${activeId}/monitor`">Monitor ↗</RouterLink>
        </div>
      </header>

      <div ref="scrollEl" class="messages">
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
              </div>
              <details>
                <summary>展开本轮 agent loop</summary>
                <div class="mini-loop">
                  <div v-for="span in runForAssistant(idx)?.spans" :key="span.id" class="mini-span">
                    <span class="kind" :data-kind="span.kind">{{ span.kind }}</span>
                    <b>{{ span.name }}</b>
                    <span>{{ fmtMs(span.duration_ms) }}</span>
                    <pre v-if="span.kind==='tool' || span.kind==='guard' || span.kind==='llm'">{{ preview(span.output) }}</pre>
                  </div>
                </div>
              </details>
            </template>
          </div>
        </article>
      </div>

      <form class="composer ls-card" @submit.prevent="send">
        <textarea v-model="draft" :disabled="sending || !connected" rows="1" placeholder="给咕咕发消息…" @keydown.enter.exact.prevent="send" />
        <div class="composer-foot">
          <span>{{ mode === 'detail' ? 'Detailed · prompt / draft / tool trace' : 'Normal conversation' }}</span>
          <button class="ls-button primary" :disabled="sending || !draft.trim() || !connected">{{ sending ? 'Running…' : 'Send' }}</button>
        </div>
      </form>
      <p v-if="error" class="error">{{ error }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { ChatMessage, GuguSession, TraceRun } from '../types'
import { listGuguSessions, loadBootstrap, loadMessages, sendMessage } from '../services/gugu'
import { getRun, listRuns } from '../services/api'

const sessions = ref<GuguSession[]>([])
const activeId = ref<number | null>(null)
const messages = ref<ChatMessage[]>([])
const runs = ref<TraceRun[]>([])
const mode = ref<'normal'|'detail'>('normal')
const draft = ref('')
const sending = ref(false)
const error = ref('')
const scrollEl = ref<HTMLElement | null>(null)
const connected = ref(!!loadBootstrap())
const activeSession = computed(() => sessions.value.find(s => s.id === activeId.value))

async function refreshSessions() {
  if (!connected.value) return
  sessions.value = await listGuguSessions()
}
async function refreshRuns() {
  if (!activeId.value) { runs.value = []; return }
  const list = await listRuns(activeId.value).catch(() => [])
  runs.value = await Promise.all(list.map(r => getRun(r.id).catch(() => r)))
}
async function selectSession(id: number) {
  activeId.value = id
  messages.value = await loadMessages(id)
  await refreshRuns()
  await nextTick()
  scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight })
}
function newSession() {
  activeId.value = null
  messages.value = []
  runs.value = []
  draft.value = ''
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
    // Collector 是 best-effort 异步发送；短轮询仅用于把刚完成的 Run 绑定回当前气泡。
    const before = runs.value.length
    for (let i = 0; i < 6; i += 1) {
      await new Promise(r => setTimeout(r, 160))
      await refreshRuns()
      if (runs.value.length > before) break
    }
    ai.runId = runs.value[runs.value.length - 1]?.id
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
  if (message?.runId) return runs.value.find(r => r.id === message.runId)
  const assistantCount = messages.value.filter(m => m.role === 'assistant').length
  const offset = Math.max(0, assistantCount - runs.value.length)
  const ordinal = assistantOrdinal(messageIndex) - offset
  return ordinal >= 0 ? runs.value[ordinal] : undefined
}
function spanCount(run: TraceRun | undefined, kind: string) { return run?.spans?.filter(s => s.kind === kind).length ?? 0 }
function fmtMs(v: number | null | undefined) { return v == null ? '—' : `${Math.round(v)}ms` }
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
.workspace { min-height:100vh; display:grid; grid-template-columns:250px minmax(0,1fr); }
.sessions { border-right:1px solid var(--border-subtle); padding:24px 14px; background:rgba(255,255,255,.34); }
.sessions header,.conversation-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
h1,h2 { margin:3px 0 0; font-size:18px; }
.eyebrow { font-size:10px; letter-spacing:.11em; color:var(--content-tertiary); font-weight:600; }
.new { border:0; background:var(--action-soft); color:var(--action-primary); border-radius:10px; width:32px; height:32px; }
.session-row { width:100%; margin-top:8px; display:grid; grid-template-columns:auto 1fr auto; gap:8px; align-items:center; text-align:left; border:1px solid transparent; background:transparent; border-radius:12px; padding:10px; color:var(--content-secondary); }
.session-row:hover { background:var(--surface-card); }
.session-row.active { background:var(--surface-raised); border-color:var(--border-subtle); box-shadow:var(--elevation-card); color:var(--content-primary); }
.source,.sid { font-size:10px; color:var(--content-tertiary); font-family:var(--font-mono); }
.source { padding:3px 5px; background:var(--surface-soft); border-radius:5px; }
.session-title { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:12px; }
.conversation { height:100vh; display:grid; grid-template-rows:auto minmax(0,1fr) auto auto; }
.conversation-head { padding:20px 28px 14px; border-bottom:1px solid var(--border-subtle); }
.head-actions { display:flex; align-items:center; gap:8px; }
.mode-switch { display:flex; background:var(--surface-soft); border-radius:10px; padding:3px; }
.mode-switch button { border:0; background:transparent; padding:6px 9px; border-radius:8px; color:var(--content-secondary); font-size:11px; }
.mode-switch button.active { background:var(--surface-raised); color:var(--content-primary); box-shadow:var(--elevation-card); }
.monitor-link { display:inline-flex; align-items:center; text-decoration:none; font-size:11px; }
.messages { overflow:auto; padding:28px max(28px, calc((100% - 780px)/2)); }
.message { max-width:720px; margin:0 auto 24px; }
.role { font-size:9px; letter-spacing:.12em; color:var(--content-tertiary); margin-bottom:6px; }
.message.user .bubble { margin-left:auto; background:var(--action-soft); }
.bubble { width:fit-content; max-width:85%; white-space:pre-wrap; line-height:1.7; padding:11px 14px; border-radius:15px; background:var(--surface-raised); border:1px solid var(--border-subtle); box-shadow:var(--elevation-card); }
.typing { opacity:.45; animation:blink 1s infinite; }
@keyframes blink { 50% { opacity:0; } }
.inline-trace { margin-top:8px; border-left:2px solid var(--trace-llm); padding:7px 0 2px 10px; font-size:11px; color:var(--content-secondary); }
.trace-summary { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.run-state { width:6px; height:6px; border-radius:50%; background:var(--status-success); }
.inline-trace summary { margin-top:7px; cursor:pointer; color:var(--action-primary); }
.mini-loop { margin-top:8px; display:grid; gap:5px; }
.mini-span { display:grid; grid-template-columns:60px 1fr auto; gap:8px; align-items:start; padding:7px; background:var(--surface-soft); border-radius:8px; }
.mini-span pre { grid-column:2/4; margin:4px 0 0; white-space:pre-wrap; max-height:130px; overflow:auto; font-size:10px; }
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
