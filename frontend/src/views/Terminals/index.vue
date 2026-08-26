<template>
  <div class="terminals-page">
    <section class="terminals-panel glass-card design-section">
      <div v-if="error && !selected" class="terminal-page-error" role="alert">{{ error }}</div>
      <div v-if="!enabled" class="terminal-empty">Shell 当前不可用</div>
      <div v-else class="terminal-layout">
        <aside class="terminal-list semantic-group">
          <button v-for="item in terminals" :key="item.id" class="terminal-item" :class="{ active: item.id === selectedId }" @click="select(item.id)">
            <span class="terminal-item-icon"><Icon name="admin.terminal" :size="15" /></span>
            <span class="terminal-item-copy"><b>{{ item.name }}</b><small>{{ item.source === 'agent' ? '咕咕' : '用户' }} · {{ statusLabel(item.status) }}</small></span>
            <span class="terminal-status" :class="item.status"></span>
          </button>
          <div v-if="!terminals.length" class="terminal-list-empty">暂无终端</div>
          <button class="terminal-add-card" :disabled="!enabled" @click="createTerminal">
            <Icon name="action.add" :size="20" style="opacity:0.5" />
            <span class="terminal-add-card-text">添加终端</span>
          </button>
        </aside>
        <main class="terminal-main" :class="{ 'is-empty': !selected }">
          <div v-if="selected" class="terminal-main-head glass-card">
            <div class="terminal-title">
              <input v-if="renaming" v-model="renameValue" class="terminal-rename" maxlength="200" @keydown.enter="saveRename" @keydown.esc="cancelRename" />
              <h2 v-else>{{ selected.name }}</h2>
              <span>{{ selected.shellMode }} · {{ selected.networkProfile }} · {{ selected.outputChars }} 字符</span>
              <small v-if="selected.sessionId || selected.runId" class="terminal-associations">会话 {{ selected.sessionId ?? '—' }} · Run {{ selected.runId ?? '—' }}</small>
            </div>
            <div class="terminal-actions">
              <ActionButton v-if="renaming" variant="secondary" fit @click="saveRename">保存</ActionButton>
              <ActionButton v-if="renaming" variant="secondary" fit @click="cancelRename">取消</ActionButton>
              <ActionButton v-else variant="secondary" fit @click="startRename"><Icon name="action.edit" :size="14" />重命名</ActionButton>
              <ActionButton v-if="selected.status !== 'terminated' && selected.status !== 'exited'" variant="secondary" fit @click="terminate"><Icon name="action.stop" :size="16" />停止</ActionButton><ActionButton v-else variant="secondary" fit @click="reopenTerminal"><Icon name="action.refresh" :size="14" />开启</ActionButton><ActionButton class="terminal-delete-action" variant="secondary" fit @click="deleteSelected"><Icon name="action.delete" :size="14" />删除</ActionButton>
            </div>
          </div>
          <div v-if="selected" ref="outputRef" class="terminal-output">
            <div v-if="error" class="terminal-output-error" role="alert">[错误] {{ error }}</div>
            <div v-for="event in events" :key="event.sequence" class="terminal-event">
              <div v-if="event.type === 'command'" class="terminal-command"><span>$</span> {{ event.command }}</div>
              <div v-else class="terminal-command terminal-status-event">终端状态已更新</div>
              <pre v-if="event.stdout">{{ event.stdout }}</pre>
              <pre v-if="event.stderr" class="stderr">{{ event.stderr }}</pre>
              <small>退出码 {{ event.exitCode ?? '—' }} · {{ formatTime(event.occurredAt) }}</small>
            </div>
            <div v-if="!events.length" class="terminal-output-empty">等待终端输出</div>
          </div>
          <div v-else class="terminal-empty">选择一个终端开始查看</div>
          <form v-if="selected && selected.status !== 'terminated' && selected.status !== 'exited'" class="terminal-input" @submit.prevent="submitCommand">
            <input ref="commandInput" v-model="command" :disabled="selected.status === 'terminated' || selected.status === 'exited'" placeholder="输入受控 Shell 命令" autocomplete="off" />
            <ActionButton fit type="submit" :disabled="!command.trim() || submitting || selected.status === 'terminated' || selected.status === 'exited'"><Icon name="action.send" :size="14" />执行</ActionButton>
          </form>
          <div v-else-if="selected" class="terminal-input-hint">该终端已停止，点击“开启”后可继续输入。</div>
        </main>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ActionButton from '@/components/common/ActionButton.vue'
import Icon from '@/components/common/Icon.vue'
import { confirmDialog } from '@/composables/useConfirmDialog'
import { terminalsApi, type TerminalEventItem, type TerminalItem } from '@/services/api'
import { useLiveStore } from '@/stores/live'

const terminals = ref<TerminalItem[]>([])
const selectedId = ref<string | null>(null)
const events = ref<TerminalEventItem[]>([])
const enabled = ref(false)
const error = ref('')
const outputRef = ref<HTMLElement | null>(null)
const commandInput = ref<HTMLInputElement | null>(null)
const command = ref('')
const submitting = ref(false)
const renaming = ref(false)
const renameValue = ref('')
let streamGeneration = 0
let eventsAbortController: AbortController | null = null
const route = useRoute()
const live = useLiveStore()

const selected = computed(() => terminals.value.find(item => item.id === selectedId.value) ?? null)

async function load() {
  try {
    const data = await terminalsApi.list()
    enabled.value = data.enabled
    terminals.value = data.items
    const requestedId = typeof route.query.terminalId === 'string' ? route.query.terminalId : null
    if (requestedId && terminals.value.some(item => item.id === requestedId)) selectedId.value = requestedId
    else if (!selectedId.value || !terminals.value.some(item => item.id === selectedId.value)) selectedId.value = terminals.value[0]?.id ?? null
    if (selectedId.value) await loadEvents(selectedId.value, true)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '终端读取失败' }
}

async function loadEvents(id: string, reset = false, controller?: AbortController) {
  if (reset) {
    eventsAbortController?.abort()
    eventsAbortController = new AbortController()
  }
  const activeController = controller ?? eventsAbortController ?? new AbortController()
  eventsAbortController = activeController
  const generation = ++streamGeneration
  if (reset) { events.value = [] }
  const cursor = reset ? 0 : (events.value.at(-1)?.sequence ?? 0)
  try {
    await terminalsApi.events(id, cursor, activeController.signal, event => {
      if (generation !== streamGeneration || id !== selectedId.value) return
      if (events.value.some(item => item.sequence === event.sequence)) return
      events.value.push(event)
      void nextTick(() => { if (outputRef.value) outputRef.value.scrollTop = outputRef.value.scrollHeight })
    })
    if (generation !== streamGeneration || id !== selectedId.value) return
    if (activeController.signal.aborted || selected.value?.status === 'terminated' || selected.value?.status === 'exited') return
    await loadEvents(id, false, activeController)
  } catch (cause) {
    if (activeController.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return
    if (generation === streamGeneration && id === selectedId.value) error.value = cause instanceof Error ? cause.message : '终端事件读取失败'
  }
}

function select(id: string) { selectedId.value = id; void loadEvents(id, true) }

// 终端输出优先消费统一业务事件；切换终端和断线时仍用 sequence API 补拉，避免 Redis pub/sub 丢消息。
watch(() => live.resourceEvent, (event) => {
  if (!event || event.resource !== 'terminals') return
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, any> : null
  const terminalId = String(event.entity_id ?? payload?.terminal_id ?? '')
  if (event.operation === 'delete') {
    terminals.value = terminals.value.filter(item => item.id !== terminalId)
    if (selectedId.value === terminalId) {
      eventsAbortController?.abort()
      selectedId.value = terminals.value[0]?.id ?? null
      events.value = []
    }
    return
  }
  const terminal = payload?.terminal as TerminalItem | undefined
  if (terminal) {
    const index = terminals.value.findIndex(item => item.id === terminal.id)
    if (event.operation === 'create' && index < 0) terminals.value.unshift(terminal)
    else if (index >= 0) terminals.value[index] = terminal
  }
  const terminalEvent = payload?.event as TerminalEventItem | undefined
  if (event.operation === 'append' && terminalEvent && terminalId === selectedId.value
      && !events.value.some(item => item.sequence === terminalEvent.sequence)) {
    events.value.push(terminalEvent)
    void nextTick(() => { if (outputRef.value) outputRef.value.scrollTop = outputRef.value.scrollHeight })
  }
})
function startRename() { if (selected.value) { renameValue.value = selected.value.name; renaming.value = true } }
function cancelRename() { renaming.value = false; renameValue.value = '' }
async function saveRename() {
  if (!selected.value || !renameValue.value.trim()) return
  try {
    const item = await terminalsApi.rename(selected.value.id, renameValue.value.trim())
    const index = terminals.value.findIndex(value => value.id === item.id)
    if (index >= 0) terminals.value[index] = item
    cancelRename()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '终端重命名失败' }
}
async function submitCommand() {
  if (!selected.value || !command.value.trim() || submitting.value || selected.value.status === 'terminated' || selected.value.status === 'exited') return
  const submittedCommand = command.value.trim()
  command.value = ''
  submitting.value = true
  error.value = ''
  try {
    const data = await terminalsApi.input(selected.value.id, { command: submittedCommand })
    const index = terminals.value.findIndex(value => value.id === data.terminal.id)
    if (index >= 0) terminals.value[index] = data.terminal
    // 输入接口会发布 append 事件，现有 SSE 会增量更新输出；不要重置或重建事件流，
    // 否则会清空输出列表并让终端内容短暂闪空。
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '命令执行失败'
    if (!command.value) command.value = submittedCommand
  }
  finally {
    submitting.value = false
    await nextTick(() => {
      if (selected.value?.status !== 'terminated' && selected.value?.status !== 'exited') commandInput.value?.focus()
    })
  }
}
async function createTerminal() {
  try { const item = await terminalsApi.create({ name: `终端 ${terminals.value.length + 1}` }); terminals.value.unshift(item); select(item.id) } catch (cause) { error.value = cause instanceof Error ? cause.message : '终端创建失败' }
}
async function terminate() { if (selected.value) { await terminalsApi.terminate(selected.value.id); await load() } }
async function reopenTerminal() {
  if (!selected.value || !['exited', 'terminated'].includes(selected.value.status)) return
  try {
    const item = await terminalsApi.reopen(selected.value.id)
    const index = terminals.value.findIndex(value => value.id === item.id)
    if (index >= 0) terminals.value[index] = item
    await loadEvents(item.id, true)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '终端开启失败' }
}
async function deleteSelected() {
  if (!selected.value) return
  const target = selected.value
  if (!await confirmDialog({
    title: '删除终端',
    message: `永久删除终端“${target.name}”及其输出？此操作不可恢复。`,
    tone: 'danger',
    confirmText: '删除终端',
  })) return
  try {
    await terminalsApi.delete(target.id)
    await load()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '终端删除失败' }
}
function statusLabel(status: string) { return ({ idle: '空闲', running: '运行中', waiting_confirm: '等待确认', exited: '已退出', failed: '异常', terminated: '已停止' } as Record<string, string>)[status] ?? status }
function formatTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
onMounted(load)
onUnmounted(() => { streamGeneration++; eventsAbortController?.abort() })
</script>

<style scoped>
.terminals-page { height:100%; min-height:0; font-family:var(--font-sans); }
.terminals-panel { position:relative; height:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:22px 24px; --glass-card-background:var(--column-bg); --glass-card-background-hover:var(--column-bg); }
.terminals-header,.terminal-main-head { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.terminals-header { margin-bottom:18px; }
.terminals-header h1,.terminal-main-head h2 { margin:0; color:var(--content-primary); }
.terminals-header h1 { font-size:20px; }
.terminals-header p { margin:5px 0 0; color:var(--content-secondary); font-size:12px; }
.terminal-layout { display:grid; grid-template-columns:240px minmax(0,1fr); gap:12px; min-height:0; flex:1; }
.terminal-list { min-width:0; overflow:auto; padding-right:4px; }
.terminal-item { display:flex; align-items:center; gap:9px; width:100%; padding:10px; margin-bottom:6px; border:1px solid var(--border-default); border-radius:var(--radius-sm); color:var(--content-secondary); text-align:left; cursor:pointer; }
.terminal-item.active { color:var(--content-primary); }
.terminal-item-icon { display:grid; place-items:center; width:28px; height:28px; border-radius:var(--radius-xs); background:var(--surface-soft); color:var(--selection-fg); }
.terminal-item-copy { min-width:0; flex:1; display:flex; flex-direction:column; gap:3px; }
.terminal-item-copy b { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.terminal-item-copy small { color:var(--content-tertiary); font-size:10px; }
.terminal-status { width:7px; height:7px; flex:none; border-radius:50%; background:var(--content-tertiary); }
.terminal-status.running { background:var(--success-fg); }
.terminal-status.failed { background:var(--danger-fg); }
.terminal-list-empty,.terminal-output-empty,.terminal-empty { display:grid; place-items:center; min-height:180px; color:var(--content-tertiary); font-size:12px; }
.terminal-page-error { margin:0 0 var(--space-md); padding:8px 12px; color:var(--danger-fg); font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
.terminal-main { display:flex; flex-direction:column; min-width:0; min-height:0; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--surface-card-solid); overflow:hidden; }
.terminal-main.is-empty { border-color:transparent; background:transparent; }
.terminal-main-head { flex:none; padding:13px 15px; border-bottom:1px solid var(--divider-line); }
.terminal-main-head.glass-card { --glass-card-background:var(--surface-glass); --glass-card-background-hover:var(--surface-glass-hover); --glass-card-border:var(--border-default); --glass-card-border-hover:var(--border-hover); --glass-card-shadow:var(--elevation-card); --glass-card-shadow-hover:var(--elevation-card-hover); border:0; border-bottom:1px solid var(--divider-line); border-radius:0; }
.terminal-main-head h2 { height:var(--control-height-sm); margin:0; font-size:14px; line-height:var(--control-height-sm); }
.terminal-main-head span { display:block; margin-top:4px; color:var(--content-tertiary); font-size:10px; }
.terminal-actions { display:flex; gap:8px; }
.terminal-output { min-height:0; flex:1; overflow:auto; padding:16px; background:#101319; color:#e7edf7; font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.01em; }
.terminal-output-empty { color:#778196; }
.terminal-output-error { padding:0 0 12px; margin-bottom:14px; border-bottom:1px solid color-mix(in srgb,var(--danger-fg) 32%,transparent); color:var(--danger-fg); font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; }
.terminal-event { padding-bottom:14px; margin-bottom:14px; border-bottom:1px solid var(--divider-line); }
.terminal-command { color:var(--selection-fg); white-space:pre-wrap; overflow-wrap:anywhere; }
.terminal-command span { color:var(--success-fg); }
.terminal-event pre { margin:6px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; }
.terminal-event pre.stderr { color:var(--danger-fg); }
.terminal-event small { display:block; margin-top:7px; color:#aab4c5; font:11px/1.4 var(--font-sans); }
.terminal-title { min-width:0; }
.terminal-rename { box-sizing:border-box; width:min(320px, 45vw); height:var(--control-height-sm); padding:5px 8px; border:1px solid var(--input-border); border-radius:var(--input-radius); outline:none; background:var(--input-bg); color:var(--input-fg); font:inherit; line-height:calc(var(--control-height-sm) - 2px); transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.terminal-input { display:flex; gap:8px; padding:10px 12px; border-top:1px solid var(--divider-line); background:var(--surface-card-solid); }
.terminal-input input { min-width:0; flex:1; border:1px solid var(--input-border); border-radius:var(--input-radius); outline:none; background:var(--input-bg); color:var(--input-fg); padding:8px 10px; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.terminal-rename:focus,
.terminal-input input:focus { background:var(--input-bg-focus); border-color:var(--input-border-focus); box-shadow:var(--input-focus-shadow); }
.terminal-input input::placeholder { color:var(--input-placeholder); opacity:1; }
.terminal-rename::selection,
.terminal-input input::selection { background:var(--selection-bg); color:var(--selection-fg); }
.terminal-input-hint { padding:10px 12px; border-top:1px solid var(--divider-line); color:var(--content-tertiary); font-size:11px; }
.terminal-add-card { display:flex; align-items:center; justify-content:center; gap:8px; width:100%; flex-shrink:0; min-height:50px; margin:0 0 6px; padding:10px; background:var(--inline-action-bg); border:1px solid var(--inline-action-border); border-radius:var(--radius-md); corner-shape:squircle; color:var(--inline-action-fg); cursor:pointer; transition:border-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard), background var(--motion-hover-control) var(--motion-ease-standard); }
.terminal-add-card:hover:not(:disabled) { background:var(--inline-action-bg-hover); border-color:var(--inline-action-border-hover); color:var(--inline-action-fg-hover); }
.terminal-add-card:disabled { cursor:not-allowed; opacity:.5; }
.terminal-add-card-text { font-size:12px; font-weight:600; }
.terminal-associations { color:var(--content-tertiary); font-size:10px; }
.terminals-panel.design-section { padding:var(--space-xl); background:var(--design-section-bg); border:1px solid var(--design-section-border); border-radius:var(--design-section-radius); box-shadow:var(--design-section-shadow), inset 0 1px 0 var(--design-section-highlight); backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px); }
.terminal-list.semantic-group { padding:var(--space-lg); border:1px solid var(--border-subtle); border-radius:var(--radius-md); background:var(--surface-soft); box-shadow:none; }
.terminal-actions :deep(.app-action-button) { min-height:var(--control-height-sm); padding:0 var(--space-sm); border-color:transparent; background:transparent; color:var(--content-secondary); box-shadow:none; transform:none; }
.terminal-actions :deep(.app-action-button:hover:not(:disabled)) { border-color:transparent; background:var(--surface-soft); color:var(--content-primary); box-shadow:none; transform:none; }
.terminal-actions :deep(.app-action-button:active:not(:disabled)) { border-color:transparent; background:var(--surface-soft); color:var(--content-primary); box-shadow:none; transform:none; }
.terminal-actions :deep(.terminal-delete-action:active:not(:disabled)) { background:transparent; color:var(--content-secondary); }
.terminals-page .terminal-item { position:relative; overflow:hidden; background:color-mix(in srgb,var(--surface-raised) 78%,transparent); border-color:var(--border-default); box-shadow:var(--elevation-card); transition:var(--card-motion); }
.terminals-page .terminal-item::after { content:''; position:absolute; inset:0; border-radius:inherit; background:var(--card-hover-overlay); box-shadow:inset 0 1px 0 var(--highlight-soft); opacity:0; pointer-events:none; transition:opacity var(--hover-motion-card); }
.terminals-page .terminal-item > * { position:relative; z-index:1; }
.terminals-page .terminal-item:hover,
.terminals-page .terminal-item.active { background:var(--surface-raised); border-color:var(--border-hover); box-shadow:var(--elevation-card-hover); }
.terminals-page .terminal-item:hover::after,
.terminals-page .terminal-item.active::after { opacity:1; }
@media(max-width:700px){.terminals-panel{padding:16px}.terminal-layout{grid-template-columns:1fr}.terminal-list{max-height:170px}.terminal-main{min-height:360px}}
</style>
