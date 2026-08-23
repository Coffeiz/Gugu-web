<template>
  <div class="trace-wrap">
    <div class="trace-list">
      <div class="trace-search">
        <input v-model="userFilter" placeholder="按用户名筛选…" @keyup.enter="refresh" />
        <button @click="refresh">搜索</button>
      </div>
      <div v-if="loading" class="trace-hint">加载中…</div>
      <template v-else>
        <div v-for="item in sessions" :key="item.id" class="trace-sess"
          :class="{ active: selectedId === item.id }" @click="open(item.id)">
          <div class="ts-top"><span class="ts-src" :class="'src-' + item.source">{{ item.source }}</span><span class="ts-title">{{ item.title }}</span></div>
          <div class="ts-meta">{{ item.user }} · {{ item.msgCount }} 条 · #{{ item.id }} · {{ formatTime(item.updatedAt) }}</div>
        </div>
        <div v-if="!sessions.length" class="trace-hint">无会话</div>
      </template>
    </div>
    <div class="trace-detail">
      <div v-if="detailLoading" class="trace-empty">加载中…</div>
      <div v-else-if="!detail" class="trace-empty">← 左侧选一个会话，查看咕咕每轮的决策轨迹</div>
      <template v-else>
        <div class="trace-head">
          <div class="th-title">{{ detail.session.title }}</div>
          <div class="th-meta">{{ detail.session.user }} · {{ detail.session.source }} · #{{ detail.session.id }} · LLM 调用 {{ tokens.calls }} 次 · token 入 {{ tokens.in }} / 出 {{ tokens.out }}</div>
        </div>
        <div class="trace-timeline">
          <div v-for="(step, i) in steps" :key="i" class="tstep" :class="'k-' + step.kind">
            <template v-if="step.kind === 'user'">
              <div class="tstep-role user">用户</div><div class="tstep-text">{{ step.text }}</div>
            </template>
            <template v-else-if="step.kind === 'ai'">
              <div class="tstep-role ai">咕咕</div><div class="tstep-text">{{ step.text }}</div>
              <div v-if="step.files?.length" class="tstep-files">📎 {{ step.files.map((file: any) => file.name + '.' + file.ext).join('，') }}</div>
            </template>
            <template v-else-if="step.kind === 'tool_call'">
              <div class="tstep-tool"><span class="tool-badge call">🔧 {{ step.name }}</span><button class="tool-toggle" @click="step._open = !step._open">{{ step._open ? '收起入参' : '入参' }}</button></div>
              <pre v-if="step._open" class="tool-json">{{ step.input }}</pre>
            </template>
            <template v-else-if="step.kind === 'tool_result'">
              <div class="tstep-tool"><span class="tool-badge res" :class="{ err: step.isError }">↩ {{ step.isError ? '结果（错误）' : '结果' }}</span><button class="tool-toggle" @click="step._open = !step._open">{{ step._open ? '收起' : '展开' }}</button></div>
              <pre v-if="step._open" class="tool-json">{{ step.result }}</pre>
            </template>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'

const adminStore = useAdminStore()
const sessions = ref<any[]>([])
const loading = ref(false)
const detailLoading = ref(false)
const selectedId = ref<number | null>(null)
const detail = ref<any | null>(null)
const steps = ref<any[]>([])
const userFilter = ref('')

const tokens = computed(() => {
  const usage = detail.value?.usage ?? []
  return { calls: usage.length, in: usage.reduce((n: number, item: any) => n + Number(item.input_tokens || 0), 0), out: usage.reduce((n: number, item: any) => n + Number(item.output_tokens || 0), 0) }
})
function formatTime(value: string) { return value ? new Date(value).toLocaleString('zh-CN') : '' }
function extractResult(content: any) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(item => typeof item === 'string' ? item : (item?.text ?? JSON.stringify(item))).join('\n')
  return JSON.stringify(content, null, 2)
}
function buildSteps(messages: any[]) {
  const result: any[] = []
  for (const message of messages) {
    const blocks = message.contentJson
    if (!blocks) {
      const text = (message.content || '').trim()
      if (text) result.push({ kind: message.role === 'assistant' || message.role === 'ai' ? 'ai' : 'user', text, files: message.files, _open: false })
      continue
    }
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && (block.text || '').trim()) result.push({ kind: 'ai', text: block.text, _open: false })
      else if (block.type === 'tool_use') result.push({ kind: 'tool_call', name: block.name, input: JSON.stringify(block.input ?? {}, null, 2), _open: false })
      else if (block.type === 'tool_result') result.push({ kind: 'tool_result', result: extractResult(block.content), isError: !!block.is_error, _open: false })
    }
  }
  return result
}
async function refresh() {
  loading.value = true
  try {
    const qs = new URLSearchParams()
    if (userFilter.value.trim()) {
      qs.set('q', userFilter.value.trim())
      qs.set('user', userFilter.value.trim())
    }
    const res = await adminStore.authFetch(`/api/v1/admin/agent/sessions${qs.toString() ? '?' + qs : ''}`)
    if (!res.ok) throw new Error('加载决策轨迹失败')
    sessions.value = await res.json()
  } finally { loading.value = false }
}
async function open(id: number) {
  selectedId.value = id
  detailLoading.value = true
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/sessions/${id}/trace`)
    if (!res.ok) throw new Error('加载决策轨迹详情失败')
    detail.value = await res.json()
    steps.value = buildSteps(detail.value?.messages || [])
  } finally { detailLoading.value = false }
}
void refresh()
</script>

<style scoped>
.trace-wrap { display:grid; grid-template-columns:300px 1fr; gap:14px; height:calc(100vh - 230px); min-height:420px; }
.trace-list { display:flex; flex-direction:column; gap:6px; overflow-y:auto; padding-right:4px; }
.trace-search { display:flex; gap:6px; position:sticky; top:0; padding-bottom:6px; }
.trace-search input { flex:1; min-width:0; padding:7px 10px; border-radius:8px; border:1px solid var(--border-subtle); background:var(--surface-soft); color:var(--content-primary); font-size:12px; }
.trace-search button { padding:0 12px; border-radius:8px; border:1px solid var(--border-strong); background:var(--surface-soft); color:var(--content-secondary); font-size:12px; cursor:pointer; }
.trace-hint,.trace-empty { color:var(--content-tertiary); font-size:12px; padding:12px; text-align:center; }
.trace-sess { padding:9px 11px; border-radius:10px; border:1px solid var(--border-subtle); background:var(--surface-soft); cursor:pointer; transition:background var(--motion-fast),border-color var(--motion-fast); }
.trace-sess:hover,.trace-sess.active { background:var(--surface-soft-hover); border-color:var(--border-hover); }
.ts-top { display:flex; gap:7px; align-items:center; min-width:0; }.ts-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--content-primary); font-size:12px; }.ts-src { color:var(--action-primary); font-size:10px; }.ts-meta { margin-top:4px; color:var(--content-tertiary); font-size:10px; }
.trace-detail { overflow-y:auto; border:1px solid var(--border-subtle); border-radius:12px; background:var(--surface-soft); padding:16px; }.trace-empty { padding-top:60px; }.trace-head { border-bottom:1px solid var(--border-subtle); padding-bottom:10px; margin-bottom:14px; }.th-title { color:var(--content-primary); font-size:14px; }.th-meta { margin-top:4px; color:var(--content-tertiary); font-size:11px; }.trace-timeline { display:flex; flex-direction:column; gap:10px; }.tstep { padding:9px 11px; border-radius:9px; border:1px solid var(--border-subtle); background:var(--surface-soft); }.tstep-role { margin-bottom:4px; font-size:11px; color:var(--action-primary); }.tstep-text { white-space:pre-wrap; color:var(--content-secondary); font-size:12px; line-height:1.6; }.tstep-files { margin-top:4px; color:var(--content-tertiary); font-size:10px; }.tstep-tool { display:flex; align-items:center; justify-content:space-between; gap:8px; }.tool-badge { color:var(--content-secondary); font-size:11px; }.tool-badge.err { color:var(--danger); }.tool-toggle { border:0; background:none; color:var(--action-primary); cursor:pointer; font-size:11px; }.tool-json { margin:8px 0 0; max-height:260px; overflow:auto; white-space:pre-wrap; color:var(--content-tertiary); font-size:10px; }
</style>
