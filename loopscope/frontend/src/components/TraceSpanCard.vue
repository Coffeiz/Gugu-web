<template>
  <article class="span-card ls-card" :class="{ child: depth > 0 }">
    <header class="span-head">
      <span class="kind-rail" :data-kind="span.kind"></span>
      <div class="span-title">
        <div class="title-line">
          <span class="kind" :data-kind="span.kind">{{ span.kind }}</span>
          <strong>{{ span.name }}</strong>
          <span v-if="contextLabel" class="context-label">{{ contextLabel }}</span>
          <span class="status" :data-status="span.status">{{ span.status }}</span>
        </div>
        <div v-if="codeLabel" class="code-line" title="Python source">
          <span>⌁</span><code>{{ codeLabel }}</code>
        </div>
      </div>
      <div class="metrics">
        <span v-if="span.duration_ms != null">{{ fmtMs(span.duration_ms) }}</span>
        <span v-for="chip in tokenChips" :key="chip" class="token-chip">{{ chip }}</span>
      </div>
    </header>

    <div class="panel-actions">
      <button v-if="sourceContent" :class="{ active: open.content }" @click="toggle('content')">Content</button>
      <button v-if="assembly" :class="{ active: open.assembly }" @click="toggle('assembly')">Assembly</button>
      <button v-if="diagnostics" :class="{ active: open.diagnostics }" @click="toggle('diagnostics')">Diagnostics</button>
      <button v-if="schemaError" :class="{ active: open.schema }" @click="toggle('schema')">Schema</button>
      <button :class="{ active: open.input }" @click="toggle('input')">
        {{ firstDiff ? `Input · #${firstDiff.index}` : 'Input' }}
      </button>
      <button :class="{ active: open.output }" @click="toggle('output')">Output</button>
      <button v-if="hasSource" :class="{ active: open.source }" @click="toggle('source')">Source</button>
      <button v-if="hasAttributes" :class="{ active: open.attributes }" @click="toggle('attributes')">Attributes</button>
    </div>

    <section v-if="open.content && sourceContent" class="panel content-panel">
      <div class="panel-label">Included content</div>
      <pre>{{ sourceContent }}</pre>
    </section>
    <section v-if="open.assembly && assembly" class="panel assembly-panel">
      <div class="assembly-grid">
        <div><span>System</span><strong>{{ assembly.system?.location || '—' }}</strong></div>
        <div><span>Reuse</span><strong>{{ assembly.system?.reused ? `round ${assembly.system.source_round || 1}` : 'inline' }}</strong></div>
        <div><span>Digest</span><code>{{ assembly.system?.digest || '—' }}</code></div>
        <div><span>Messages</span><strong>{{ assembly.messages?.count ?? '—' }}</strong></div>
      </div>
      <p class="assembly-note">完整 system 文本只在 Context assembly 中展示；本轮通过 digest 与来源重建实际组装关系。</p>
    </section>
    <section v-if="firstDiff" class="panel first-diff-panel">
      <div class="first-diff-head">
        <div>
          <div class="panel-label">Earliest input change</div>
          <strong>消息 #{{ firstDiff.index }}</strong>
        </div>
        <span class="diff-reason">{{ diffReasonLabel }}</span>
      </div>
      <div class="first-diff-meta">
        <span>上一轮：{{ firstDiff.previous?.shape?.representation || '—' }}</span>
        <span>本轮：{{ firstDiff.current?.shape?.representation || '—' }}</span>
        <span>前缀：{{ prefixStable ? '未变化' : '已断开' }}</span>
      </div>
      <div class="first-diff-actions">
        <p class="first-diff-note">Input 已标记这条消息，可直接查看完整正文。</p>
        <div class="first-diff-buttons">
          <button class="jump-input" @click="jumpToFirstDiff">定位到 Input</button>
          <button class="compare-input" :class="{ active: comparisonOpen }" @click="comparisonOpen = !comparisonOpen">对比上一轮 Input</button>
        </div>
      </div>
    </section>
    <section v-if="comparisonOpen && firstDiff" class="panel comparison-panel">
      <div class="comparison-head">
        <div class="panel-label">Input comparison</div>
        <span>消息 #{{ firstDiff.index }} · {{ diffReasonLabel }}</span>
      </div>
      <div class="comparison-grid">
        <article class="comparison-column">
          <div class="comparison-label">上一轮 Input</div>
          <pre>{{ pretty(previousInputMessages[firstDiff.index]) }}</pre>
        </article>
        <article class="comparison-column is-current">
          <div class="comparison-label">本轮 Input</div>
          <pre>{{ pretty(inputMessages[firstDiff.index]) }}</pre>
        </article>
      </div>
    </section>
    <section v-if="open.diagnostics && diagnostics" class="panel diagnostics-panel">
      <div class="panel-label">Context diagnostics</div>
      <pre>{{ pretty(diagnostics) }}</pre>
    </section>
    <section v-if="open.schema && schemaError" class="panel schema-error-panel">
      <div class="panel-label">Schema error trace</div>
      <div class="schema-error-meta">
        <span>工具：<code>{{ schemaError.tool_name || '—' }}</code></span>
        <span>类型：<code>{{ schemaError.error_kind || '—' }}</code></span>
        <span>Digest：<code>{{ schemaError.schema_digest || '—' }}</code></span>
      </div>
      <div class="schema-error-grid">
        <div><div class="panel-label">Model schema</div><pre>{{ pretty(schemaError.provider_schema || schemaError.schema) }}</pre></div>
        <div><div class="panel-label">Validation error</div><pre>{{ pretty(schemaError.error) }}</pre></div>
      </div>
      <div class="panel-label">Arguments shape</div>
      <pre>{{ pretty(schemaError.arguments_shape) }}</pre>
    </section>
    <section v-if="open.input" ref="inputPanel" class="panel input-panel">
      <div class="panel-label">Input</div>
      <div v-if="systemPrompt" class="input-system-prompt">
        <div class="input-message-label">
          <span>System prompt</span>
          <b>Skills / policy / stable instructions</b>
        </div>
        <pre>{{ systemPrompt }}</pre>
      </div>
      <div v-if="snapshotContent" class="input-snapshot">
        <div class="input-message-label">
          <span>Session snapshot</span>
          <b>用户侧固定上下文 · 不属于 history</b>
        </div>
        <pre>{{ snapshotContent }}</pre>
      </div>
      <div v-if="inputMessages.length && firstDiff" ref="inputMessageList" class="input-message-list">
        <article
          v-for="(message, index) in inputMessages"
          :key="index"
          class="input-message"
          :class="{ 'is-first-diff': index === firstDiff.index }"
          :data-message-index="index"
        >
          <div class="input-message-label">
            <span>Message #{{ index }}</span>
            <b v-if="index === firstDiff.index">最早变化点</b>
          </div>
          <pre>{{ pretty(message) }}</pre>
        </article>
      </div>
      <pre v-else>{{ pretty(inputWithoutSystemPrompt) }}</pre>
    </section>
    <section v-if="open.output" class="panel">
      <div class="panel-label">Output</div>
      <pre>{{ pretty(span.output) }}</pre>
    </section>
    <section v-if="open.source && hasSource" class="panel source-panel">
      <div class="source-grid">
        <div><span>File</span><code>{{ span.code?.file || '—' }}</code></div>
        <div><span>Function</span><code>{{ span.code?.qualname || span.code?.function || '—' }}</code></div>
        <div><span>Line</span><code>{{ span.code?.line ?? '—' }}</code></div>
        <div v-if="span.attributes?.path"><span>Context source</span><code>{{ span.attributes.path }}</code></div>
      </div>
    </section>
    <section v-if="open.attributes && hasAttributes" class="panel">
      <div class="panel-label">Attributes</div>
      <pre>{{ pretty(span.attributes) }}</pre>
    </section>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import type { TraceSpan } from '../types'
import { prettyJson } from '../utils/prettyJson'

const props = withDefaults(defineProps<{ span: TraceSpan; previousSpan?: TraceSpan; depth?: number }>(), { depth: 0 })
const open = reactive<Record<string, boolean>>({ content: false, assembly: false, diagnostics: false, schema: false, input: false, output: false, source: false, attributes: false })
const inputMessageList = ref<HTMLElement | null>(null)
const comparisonOpen = ref(false)

function toggle(key: string) {
  open[key] = !open[key]
}
function jumpToFirstDiff() {
  open.input = true
  void nextTick(() => {
    const target = inputMessageList.value?.querySelector<HTMLElement>('.is-first-diff')
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}
function fmtMs(v: number) { return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms` }
function fmtTokens(v: number | undefined) {
  if (!v) return ''
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k`
  return String(Math.round(v))
}
function pretty(v: unknown) {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  try { return prettyJson(v) } catch { return String(v) }
}

const sourceContent = computed(() => {
  const out = props.span.output as any
  if (!out || typeof out !== 'object') return ''
  if (typeof out.content === 'string') return out.content
  if (typeof out.included === 'string') return out.included
  if (props.span.kind === 'context' && typeof out.system_prompt === 'string') return out.system_prompt
  return ''
})
const systemPrompt = computed(() => {
  const input = props.span.input
  if (!input || typeof input !== 'object') return ''
  const value = (input as Record<string, unknown>).system_prompt
  return typeof value === 'string' ? value : ''
})
const snapshotContent = computed(() => {
  const input = props.span.input
  if (!input || typeof input !== 'object') return ''
  const snapshot = (input as Record<string, unknown>).snapshot
  if (typeof snapshot === 'string') return snapshot
  if (!snapshot || typeof snapshot !== 'object') return ''
  const content = (snapshot as Record<string, unknown>).content
  return typeof content === 'string' ? content : ''
})
const assembly = computed(() => {
  const input = props.span.input as any
  return input && typeof input === 'object' && input.assembly ? input.assembly : null
})
const diagnostics = computed(() => {
  const value = assembly.value?.canonical_context
  return value && typeof value === 'object' ? value : null
})
const schemaError = computed(() => {
  if (props.span.attributes?.context_source !== 'tool_schema_error') return null
  const input = props.span.input
  return input && typeof input === 'object' ? input as Record<string, unknown> : null
})
const firstDiff = computed(() => {
  const value = diagnostics.value?.first_diff
  if (value && value.index != null) {
    return value as {
      index: number
      reason?: string
      previous?: { shape?: { representation?: string } }
      current?: { shape?: { representation?: string } }
    }
  }
  const previousMessages = messagesFrom(props.previousSpan)
  const currentMessages = inputMessages.value
  if (!previousMessages.length || !currentMessages.length) return null
  const limit = Math.min(previousMessages.length, currentMessages.length)
  let index = 0
  while (index < limit && stableStringify(previousMessages[index]) === stableStringify(currentMessages[index])) index += 1
  if (index === limit && previousMessages.length === currentMessages.length) return null
  const previous = previousMessages[index]
  const current = currentMessages[index]
  const previousRepresentation = messageRepresentation(previous)
  const currentRepresentation = messageRepresentation(current)
  return {
    index,
    reason: previousRepresentation !== currentRepresentation ? 'wrapper_changed' : 'content_changed',
    previous: { shape: { representation: previousRepresentation } },
    current: { shape: { representation: currentRepresentation } },
  }
})
const prefixStable = computed(() => diagnostics.value?.prefix_integrity?.stable === true)
const diffReasonLabel = computed(() => {
  const labels: Record<string, string> = {
    wrapper_changed: '包装格式变化',
    role_changed: 'Role 变化',
    block_shape_changed: 'Block 结构变化',
    content_kind_changed: 'Content 类型变化',
    content_changed: '正文变化',
    message_count_changed: '消息数量变化',
  }
  return labels[String(firstDiff.value?.reason || '')] || String(firstDiff.value?.reason || '结构变化')
})
const inputMessages = computed(() => messagesFrom(props.span))
const previousInputMessages = computed(() => messagesFrom(props.previousSpan))
function messagesFrom(span?: TraceSpan) {
  const input = span?.input
  if (!input || typeof input !== 'object') return []
  const messages = (input as Record<string, unknown>).messages
  return Array.isArray(messages) ? messages : []
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function messageRepresentation(message: any): string {
  const content = message?.content
  if (typeof content === 'string') {
    const value = content.trimStart()
    if (value.startsWith('<compacted-summary>')) return 'compacted-summary'
    if (value.startsWith('## 早前对话摘要')) return 'legacy-summary-header'
    if (value.startsWith('[system-reminder]')) return 'system-reminder-text'
    return 'text'
  }
  if (Array.isArray(content)) return 'blocks'
  return typeof content
}
const inputForDisplay = computed(() => {
  const input = props.span.input
  if (!input || typeof input !== 'object' || !assembly.value || !('canonical_context' in assembly.value)) {
    return input
  }
  const { canonical_context: _diagnostics, ...visibleAssembly } = assembly.value
  return { ...(input as Record<string, unknown>), assembly: visibleAssembly }
})
const inputWithoutSystemPrompt = computed(() => {
  const input = inputForDisplay.value
  if (!systemPrompt.value || !input || typeof input !== 'object' || Array.isArray(input)) return input
  const { system_prompt: _systemPrompt, snapshot: _snapshot, ...rest } = input as Record<string, unknown>
  return rest
})
const hasSource = computed(() => !!(props.span.code?.file || props.span.code?.function || props.span.attributes?.path))
const hasAttributes = computed(() => !!props.span.attributes && Object.keys(props.span.attributes).length > 0)
const contextLabel = computed(() => {
  const source = props.span.attributes?.context_source
  if (!source) return ''
  const labels: Record<string, string> = {
    tool_schema: '工具 Schema',
    tool_schema_error: 'Schema 错误',
    capability_catalog: '能力目录',
    skill_index: 'Skill 索引',
    skill_body: 'Skill 正文',
  }
  return labels[String(source)] || '上下文注入'
})
const codeLabel = computed(() => {
  const c = props.span.code
  if (!c?.file && !c?.function) return ''
  const file = c.file || c.module || ''
  const fn = c.function || ''
  const line = c.line ? `:${c.line}` : ''
  return [file + line, fn].filter(Boolean).join(' · ')
})
const tokenChips = computed(() => {
  const u = props.span.usage ?? {}
  const t = props.span.token_impact ?? {}
  const chips: string[] = []
  if (u.input) chips.push(`in ${fmtTokens(u.input)}`)
  if (u.output) chips.push(`out ${fmtTokens(u.output)}`)
  if (u.cache_read) chips.push(`cache ${fmtTokens(u.cache_read)}`)
  if (t.prompt_tokens_actual && t.prompt_tokens_source === 'provider') chips.push(`prompt ${fmtTokens(t.prompt_tokens_actual)}`)
  else if (t.estimated_input_tokens) chips.push(`~${fmtTokens(t.estimated_input_tokens)} context`)
  else if (t.prompt_tokens_estimate) chips.push(`~${fmtTokens(t.prompt_tokens_estimate)} prompt`)
  else if (t.included_tokens) chips.push(`~${fmtTokens(t.included_tokens)} included`)
  else if (t.result_tokens) chips.push(`+~${fmtTokens(t.result_tokens)} result`)
  else if (t.source_tokens) chips.push(`~${fmtTokens(t.source_tokens)} source`)
  else if (t.followup_tokens) chips.push(`~${fmtTokens(t.followup_tokens)} prompt`)
  else if (t.output_tokens_estimate) chips.push(`~${fmtTokens(t.output_tokens_estimate)} output`)
  if (t.prompt_growth_estimate) chips.push(`+~${fmtTokens(t.prompt_growth_estimate)} growth`)
  return chips.slice(0, 4)
})
</script>

<style scoped>
.span-card { overflow:hidden; border-radius:var(--radius-md); }
.span-card.child { margin-left:20px; box-shadow:none; background:color-mix(in srgb,var(--surface-card) 82%,transparent); }
.span-head { display:grid; grid-template-columns:4px minmax(0,1fr) auto; gap:11px; align-items:stretch; min-height:58px; }
.kind-rail { background:var(--trace-context); }
.kind-rail[data-kind="llm"]{background:var(--trace-llm)}
.kind-rail[data-kind="tool"]{background:var(--trace-tool)}
.kind-rail[data-kind="guard"]{background:var(--trace-guard)}
.kind-rail[data-kind="output"]{background:var(--trace-output)}
.kind-rail[data-kind="database"]{background:var(--trace-database)}
.kind-rail[data-kind="file"]{background:var(--trace-file)}
.kind-rail[data-kind="memory"]{background:var(--trace-memory)}
.kind-rail[data-kind="history"]{background:var(--trace-history)}
.kind-rail[data-kind="cache"]{background:var(--trace-cache)}
.kind-rail[data-kind="state"]{background:var(--trace-state)}
.span-title { padding:10px 0; min-width:0; }
.title-line { display:flex; align-items:center; gap:8px; min-width:0; }
.title-line strong { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kind { flex:none; font:9px var(--font-mono); text-transform:uppercase; color:var(--content-tertiary); }
.status { flex:none; padding:2px 5px; border-radius:var(--radius-pill); font-size:8px; color:var(--content-tertiary); background:var(--surface-soft); }
.status[data-status="error"] { color:var(--status-danger); background:color-mix(in srgb,var(--status-danger) 10%,transparent); }
.context-label { flex:none; padding:2px 5px; border-radius:var(--radius-pill); color:var(--action-primary); background:var(--action-soft); font-size:8px; }
.code-line { display:flex; align-items:center; gap:5px; margin-top:4px; min-width:0; color:var(--content-tertiary); font-size:9px; }
.code-line code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.metrics { padding:10px 12px 10px 0; display:flex; align-items:center; justify-content:flex-end; gap:5px; flex-wrap:wrap; color:var(--content-tertiary); font:9px var(--font-mono); max-width:360px; }
.token-chip { padding:3px 6px; border-radius:var(--radius-pill); background:var(--action-soft); color:var(--action-primary); }
.panel-actions { display:flex; gap:5px; flex-wrap:wrap; padding:0 12px 9px 15px; }
.panel-actions button { border:1px solid var(--border-subtle); border-radius:7px; padding:4px 7px; background:transparent; color:var(--content-secondary); font-size:9px; }
.panel-actions button:hover,.panel-actions button.active { background:var(--surface-raised); color:var(--content-primary); border-color:var(--border-default); }
.panel { border-top:1px solid var(--border-subtle); padding:11px 14px; background:var(--surface-raised); }
.schema-error-meta { display:flex; flex-wrap:wrap; gap:6px 14px; margin-bottom:10px; color:var(--content-secondary); font-size:9px; }
.schema-error-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-bottom:10px; }
.schema-error-grid > div { min-width:0; }
.panel-label { margin-bottom:7px; color:var(--content-tertiary); font-size:8px; letter-spacing:.1em; text-transform:uppercase; }
pre { margin:0; max-height:420px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:10px/1.58 var(--font-mono); color:var(--content-primary); }
.first-diff-panel { background:color-mix(in srgb,var(--status-warning) 7%,var(--surface-raised)); }
.first-diff-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.first-diff-head strong { font-size:12px; }
.diff-reason { flex:none; padding:3px 7px; border-radius:var(--radius-pill); color:var(--status-warning); background:color-mix(in srgb,var(--status-warning) 14%,transparent); font-size:9px; }
.first-diff-meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; color:var(--content-secondary); font:9px var(--font-mono); }
.first-diff-meta span { padding:3px 6px; border:1px solid var(--border-subtle); border-radius:var(--radius-pill); background:var(--surface-card); }
.first-diff-actions { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:9px; }
.first-diff-buttons { display:flex; align-items:center; gap:6px; flex:none; }
.first-diff-note { margin:0; color:var(--content-tertiary); font-size:10px; line-height:1.5; }
.jump-input,.compare-input { border:1px solid color-mix(in srgb,var(--status-warning) 45%,var(--border-subtle)); border-radius:var(--radius-sm); padding:5px 8px; background:var(--surface-card); color:var(--status-warning); font-size:9px; }
.jump-input:hover { background:color-mix(in srgb,var(--status-warning) 12%,var(--surface-card)); }
.compare-input:hover,.compare-input.active { background:color-mix(in srgb,var(--action-primary) 12%,var(--surface-card)); border-color:color-mix(in srgb,var(--action-primary) 45%,var(--border-subtle)); color:var(--action-primary); }
.comparison-panel { background:color-mix(in srgb,var(--action-primary) 5%,var(--surface-raised)); }
.comparison-head { display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--content-tertiary); font:9px var(--font-mono); }
.comparison-head .panel-label { margin:0; }
.comparison-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; margin-top:9px; }
.comparison-column { min-width:0; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); overflow:hidden; background:var(--surface-card); }
.comparison-column.is-current { border-color:color-mix(in srgb,var(--action-primary) 42%,var(--border-subtle)); }
.comparison-label { padding:6px 8px; color:var(--content-secondary); background:var(--surface-soft); font-size:9px; }
.comparison-column pre { max-height:360px; padding:8px; }
.input-message-list { display:grid; gap:7px; max-height:600px; overflow:auto; padding-right:2px; }
.input-snapshot { margin-top:10px; border:1px solid color-mix(in srgb,var(--action-primary) 32%,var(--border-subtle)); border-radius:var(--radius-sm); overflow:hidden; background:color-mix(in srgb,var(--action-primary) 5%,var(--surface-card)); }
.input-snapshot pre { max-height:420px; padding:8px; }
.input-message { border:1px solid var(--border-subtle); border-radius:var(--radius-sm); overflow:hidden; background:var(--surface-card); }
.input-message.is-first-diff { border-color:var(--status-warning); box-shadow:0 0 0 2px color-mix(in srgb,var(--status-warning) 18%,transparent); }
.input-message-label { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 8px; color:var(--content-tertiary); background:var(--surface-soft); font:9px var(--font-mono); }
.input-message-label b { color:var(--status-warning); font:9px var(--font-sans); }
.input-message pre { max-height:none; padding:8px; }
.input-system-prompt { margin-bottom:9px; border:1px solid color-mix(in srgb,var(--trace-context) 45%,var(--border-subtle)); border-radius:var(--radius-sm); overflow:hidden; background:var(--surface-card); }
.input-system-prompt .input-message-label { color:var(--action-primary); }
.input-system-prompt .input-message-label b { color:var(--content-tertiary); font-weight:400; }
.input-system-prompt pre { max-height:600px; padding:9px; background:color-mix(in srgb,var(--trace-context) 5%,var(--surface-card)); }
.content-panel pre { font-family:var(--font-sans); font-size:11px; line-height:1.65; }
.assembly-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px 18px; }
.assembly-grid div { min-width:0; }
.assembly-grid span { display:block; color:var(--content-tertiary); font-size:8px; margin-bottom:3px; text-transform:uppercase; letter-spacing:.08em; }
.assembly-grid strong,.assembly-grid code { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; }
.assembly-note { margin:12px 0 0; color:var(--content-tertiary); font-size:10px; line-height:1.5; }
.source-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px 18px; }
.source-grid div { min-width:0; }
.source-grid span { display:block; color:var(--content-tertiary); font-size:8px; margin-bottom:3px; text-transform:uppercase; letter-spacing:.08em; }
.source-grid code { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; }
@media (max-width:720px) {
  .first-diff-actions { align-items:flex-start; flex-direction:column; }
  .first-diff-buttons { width:100%; flex-wrap:wrap; }
  .comparison-grid { grid-template-columns:1fr; }
  .schema-error-grid { grid-template-columns:1fr; }
}
</style>
