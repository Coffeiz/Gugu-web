<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import MarkdownView from '@/components/common/content/MarkdownView.vue'
import type { ChatMessage } from './chatTypes'
import { pLimit } from '@/utils/concurrency'
import { projectSubagentStatuses, subagentStatusKeys } from './toolActivity'
import { chatSubagentSnapshotKey } from './chatPresentationAccess'

const props = defineProps<{ messages: readonly ChatMessage[]; sessionId?: number | null }>()
const snapshotAccess = inject(chatSubagentSnapshotKey, null)
const { t, te } = useI18n()
const panelId = useId()
const anchor = ref<HTMLElement | null>(null)
const chatWindow = computed(() => anchor.value?.closest('.chat-window'))
const listWidth = ref(240)
const detailWidth = ref(270)
const stackDetails = ref(false)
const hovered = ref(false)
const pinned = ref(false)
const previewId = ref<string>()
const lockedId = ref<string>()
const selectedId = computed(() => lockedId.value ?? previewId.value)
const projectedAgents = computed(() => projectSubagentStatuses(props.messages))
type AgentStatus = keyof typeof subagentStatusKeys
type Snapshot = {
  parentRunId: string
  status?: AgentStatus
  round?: NonNullable<ReturnType<typeof projectSubagentStatuses>[number]['round']>
  task?: string
  finalMessage?: string
}
const snapshots = ref(new Map<string, Snapshot>())
function isActive(status: AgentStatus) {
  return status === 'queued' || status === 'running' || status === 'waiting'
}
const agents = computed(() => projectedAgents.value.map(agent => {
  const snapshot = snapshots.value.get(agent.id)
  if (!agent.active || !snapshot?.status || snapshot.parentRunId !== agent.parentRunId) return agent
  return { ...agent, status: snapshot.status, active: isActive(snapshot.status),
    labelKey: 'chatUi.' + subagentStatusKeys[snapshot.status] }
}).sort((a, b) => Number(b.active) - Number(a.active)))
const selected = computed(() => agents.value.find(agent => agent.id === selectedId.value))
const open = computed(() => hovered.value || pinned.value)
const selectedSnapshot = computed(() => {
  const agent = selected.value
  const snapshot = agent && snapshots.value.get(agent.id)
  return snapshot?.parentRunId === agent?.parentRunId ? snapshot : undefined
})
const finalMessage = computed(() => selectedSnapshot.value?.finalMessage ?? selected.value?.finalMessage)
const displayedRound = computed(() => {
  const snapshot = selectedSnapshot.value
  if (snapshot) return snapshot.round
  const round = selected.value?.round
  if (!round) return
  const final = finalMessage.value?.trim()
  return { ...round, messages: round.messages.filter(text => !final || !final.startsWith(text.trim())) }
})
const limitSnapshotReads = pLimit(4)
let snapshotVersion = 0
let refreshing = false
let refreshAgain = false
let snapshotTimer: ReturnType<typeof setTimeout> | undefined
async function refreshSnapshot() {
  const sessionId = props.sessionId
  if (!snapshotAccess || !open.value || !sessionId) return
  if (refreshing) { refreshAgain = true; return }
  refreshing = true
  const version = snapshotVersion
  const candidates = projectedAgents.value.filter(agent => {
    const snapshot = snapshots.value.get(agent.id)
    return agent.id === selectedId.value || (agent.active && (
      !snapshot?.status || snapshot.parentRunId !== agent.parentRunId || isActive(snapshot.status)
    ))
  })
  try {
    await Promise.all(candidates.map(agent => limitSnapshotReads(async () => {
      const parentRunId = agent.parentRunId
      if (!parentRunId || version !== snapshotVersion || !open.value) return
      try {
        const result = await snapshotAccess.read(sessionId, parentRunId, agent.id) as {
          run?: { status?: unknown }
          task?: unknown
          finalMessage?: unknown
          rounds?: Array<{ number?: unknown; messages?: unknown; toolCalls?: Array<{ name?: unknown; status?: unknown }> }>
        } | null
        if (version !== snapshotVersion || sessionId !== props.sessionId || !open.value || !result) return
        const rawStatus = result.run?.status
        const status = typeof rawStatus === 'string' && Object.hasOwn(subagentStatusKeys, rawStatus)
          ? rawStatus as AgentStatus : undefined
        const snapshot: Snapshot = { parentRunId, status,
          task: typeof result.task === 'string' ? result.task : undefined,
          finalMessage: typeof result.finalMessage === 'string' ? result.finalMessage : undefined,
        }
        const current = result.rounds?.at(-1)
        if (typeof current?.number === 'number') {
          const messages = Array.isArray(current.messages)
            ? current.messages.filter((text): text is string => typeof text === 'string') : []
          const tools = (current.toolCalls ?? []).flatMap(tool => {
            if (typeof tool.name !== 'string') return []
            const nameKey = `toolNames.${tool.name}`
            const name = te(nameKey) ? t(nameKey) : tool.name
            const key = tool.status === 'running' ? 'chatUi.toolRunning' : tool.status === 'success' ? 'chatUi.toolDone'
              : tool.status === 'error' ? 'chatUi.toolFailed' : tool.status === 'waiting' ? 'chatUi.toolWaiting'
                : tool.status === 'cancelled' ? 'chatUi.toolCancelled' : null
            return [key ? `${name} · ${t(key)}` : name]
          })
          snapshot.round = { number: current.number, messages, tools }
        }
        snapshots.value.set(agent.id, snapshot)
      } catch { /* 暂时读不到实时快照时保留已经确认的状态。 */ }
    })))
  } finally {
    refreshing = false
    if (refreshAgain) { refreshAgain = false; scheduleSnapshot() }
  }
}
function scheduleSnapshot(sessionId?: number) {
  if (sessionId !== undefined && sessionId !== props.sessionId) return
  if (snapshotTimer) clearTimeout(snapshotTimer)
  snapshotTimer = setTimeout(() => void refreshSnapshot(), 100)
}
const stopSnapshot = snapshotAccess?.subscribe(scheduleSnapshot)
watch([open, selectedId, () => props.sessionId, projectedAgents], ([visible, , sessionId, projected], previous) => {
  if (!visible || sessionId !== previous?.[2]) {
    snapshotVersion++
    snapshots.value.clear()
  } else {
    const ids = new Set(projected.map(agent => agent.id))
    for (const id of snapshots.value.keys()) if (!ids.has(id)) snapshots.value.delete(id)
  }
  if (visible) scheduleSnapshot()
})
onBeforeUnmount(() => { snapshotVersion++; if (snapshotTimer) clearTimeout(snapshotTimer); stopSnapshot?.() })
const activeCount = computed(() => agents.value.filter(agent => agent.active).length)

function positionPanels() {
  if (!anchor.value || !chatWindow.value) return
  const button = anchor.value.getBoundingClientRect()
  const windowBounds = chatWindow.value.getBoundingClientRect()
  const center = (button.left + button.right) / 2
  listWidth.value = Math.min(240, Math.max(1, 2 * Math.min(center - windowBounds.left - 8, windowBounds.right - center - 8)))
  const leftSpace = center - listWidth.value / 2 - windowBounds.left - 16
  stackDetails.value = leftSpace < 180
  detailWidth.value = Math.min(290, leftSpace)
}

watch(open, visible => { if (visible) positionPanels() })
watch(chatWindow, (element, _previous, onCleanup) => {
  if (!element) return
  const observer = new ResizeObserver(() => { if (open.value) positionPanels() })
  observer.observe(element)
  onCleanup(() => observer.disconnect())
})

function close() {
  hovered.value = false
  pinned.value = false
  previewId.value = undefined
  lockedId.value = undefined
}

function togglePreview(id: string) {
  if (lockedId.value === id) {
    lockedId.value = undefined
    previewId.value = undefined
    return
  }
  lockedId.value = id
  pinned.value = true
}

function onFocusOut(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)) return
  close()
}
</script>

<template>
  <div v-if="agents.length" ref="anchor" class="subagent-status" @mouseenter="hovered = true" @mouseleave="hovered = false"
    @focusout="onFocusOut" @keydown.esc.stop="close">
    <button type="button" class="subagent-trigger" :class="{ 'has-active': activeCount > 0 }"
      :aria-label="t('chatUi.subagent')" :aria-expanded="open" :aria-controls="panelId" @click="pinned ? close() : pinned = true">
      <Icon name="communication.team" :size="14" />
      <span>{{ activeCount || agents.length }}</span>
    </button>
    <div v-if="open" :id="panelId" class="subagent-popovers"
      :class="{ 'stack-details': stackDetails }" :style="{ width: listWidth + 'px', '--subagent-detail-width': detailWidth + 'px' }">
      <div class="subagent-popover">
        <div class="subagent-heading">{{ t('chatUi.subagent') }}</div>
        <ul>
          <li v-for="agent in agents" :key="agent.id">
            <button type="button" class="subagent-row" :aria-pressed="lockedId === agent.id"
              :class="{ 'is-previewed': selectedId === agent.id }"
              @mouseenter="previewId = agent.id" @focus="previewId = agent.id" @click="togglePreview(agent.id)">
              <span class="subagent-name">{{ agent.name || t('chatUi.subagent') }}</span>
              <code>{{ agent.id }}</code>
              <span :class="{ 'is-active': agent.active }">{{ t(agent.labelKey) }}</span>
            </button>
          </li>
        </ul>
      </div>
      <section v-if="selected" class="subagent-preview" tabindex="0" :aria-label="selected.id">
        <div class="subagent-heading">{{ selected.name || t('chatUi.subagent') }} <code>{{ selected.id }}</code></div>
        <template v-if="selectedSnapshot?.task">
          <strong>{{ t('chatUi.subagentTask') }}</strong>
          <p class="subagent-task">{{ selectedSnapshot.task }}</p>
        </template>
        <div v-if="displayedRound" class="subagent-round">
          <strong>{{ t('chatUi.subagentRound', { number: displayedRound.number }) }}</strong>
          <MarkdownView v-for="(text, index) in displayedRound.messages" :key="index" :text="text" render-math />
          <ul v-if="displayedRound.tools.length" class="subagent-tools">
            <li v-for="(tool, index) in displayedRound.tools" :key="index">{{ tool }}</li>
          </ul>
        </div>
        <template v-if="finalMessage">
          <strong>{{ t('chatUi.subagentFinal') }}</strong>
          <MarkdownView :text="finalMessage" render-math />
        </template>
        <p v-if="!displayedRound && !finalMessage">{{ t('chatUi.subagentNoRound') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.subagent-status { position: relative; flex: none; }
.subagent-trigger {
  display: flex; align-items: center; gap: 4px; padding: 3px 6px;
  border: 1px solid var(--popup-surface-border); border-radius: var(--radius-pill);
  background: var(--surface-soft); color: var(--theme-content-tertiary);
  font: inherit; font-size: var(--font-size-xs); cursor: pointer;
}
.subagent-trigger.has-active, .is-active { color: var(--action-primary); }
.subagent-popovers {
  position: absolute; z-index: 5; inset: 100% auto auto 50%;
  transform: translateX(-50%); display: grid; gap: var(--space-xs);
}
.subagent-popovers:not(.stack-details) .subagent-preview {
  position: absolute; inset: 0 calc(100% + var(--space-xs)) auto auto;
  inline-size: var(--subagent-detail-width); box-sizing: border-box;
}
.subagent-popovers:not(.stack-details):has(.subagent-preview)::before {
  content: ''; position: absolute; inset: 0 100% 0 auto; inline-size: var(--space-xs);
}
.subagent-popover, .subagent-preview {
  padding: var(--space-sm); border: 1px solid var(--popup-surface-border);
  border-radius: var(--radius-sm); background: var(--surface-card-solid);
  box-shadow: var(--popup-surface-shadow);
  color: var(--content-primary); font-size: var(--font-size-xs);
}
.subagent-heading { font-weight: 600; }
.subagent-popover ul { max-block-size: 220px; overflow: auto; margin: 4px 0 0; padding: 0; list-style: none; }
li { color: var(--theme-content-tertiary); }
.subagent-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center;
  inline-size: 100%; padding: 5px; border: 0; border-radius: var(--radius-xs);
  background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer;
}
.subagent-row.is-previewed { background: var(--surface-soft); }
.subagent-preview {
  max-block-size: min(320px, 36dvh); overflow-y: auto; overflow-wrap: anywhere; scrollbar-width: none;
}
.subagent-task { white-space: pre-wrap; overflow-wrap: anywhere; }
.subagent-round { margin-block: var(--space-sm); }
.subagent-tools { padding-inline-start: 1.25em; margin-block: var(--space-xs); list-style: disc; }
.subagent-preview > p { margin: 4px 0; }
.subagent-preview :deep(.md-view) { font-size: var(--font-size-xs); }
li + li { border-block-start: 1px solid var(--content-divider); }
.subagent-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--content-primary); }
</style>
