<template>
  <article class="span-card ls-card" :class="{ child: depth > 0 }">
    <header class="span-head">
      <span class="kind-rail" :data-kind="span.kind"></span>
      <div class="span-title">
        <div class="title-line">
          <span class="kind" :data-kind="span.kind">{{ span.kind }}</span>
          <strong>{{ span.name }}</strong>
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
      <button :class="{ active: open.input }" @click="toggle('input')">Input</button>
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
    <section v-if="open.input" class="panel">
      <div class="panel-label">Input</div>
      <pre>{{ pretty(span.input) }}</pre>
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
import { computed, reactive } from 'vue'
import type { TraceSpan } from '../types'

const props = withDefaults(defineProps<{ span: TraceSpan; depth?: number }>(), { depth: 0 })
const open = reactive<Record<string, boolean>>({ content: false, assembly: false, input: false, output: false, source: false, attributes: false })

function toggle(key: string) { open[key] = !open[key] }
function fmtMs(v: number) { return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms` }
function fmtTokens(v: number | undefined) {
  if (!v) return ''
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k`
  return String(Math.round(v))
}
function pretty(v: unknown) {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

const sourceContent = computed(() => {
  const out = props.span.output as any
  if (!out || typeof out !== 'object') return ''
  if (typeof out.content === 'string') return out.content
  if (typeof out.included === 'string') return out.included
  if (props.span.kind === 'context' && typeof out.system_prompt === 'string') return out.system_prompt
  return ''
})
const assembly = computed(() => {
  const input = props.span.input as any
  return input && typeof input === 'object' && input.assembly ? input.assembly : null
})
const hasSource = computed(() => !!(props.span.code?.file || props.span.code?.function || props.span.attributes?.path))
const hasAttributes = computed(() => !!props.span.attributes && Object.keys(props.span.attributes).length > 0)
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
.code-line { display:flex; align-items:center; gap:5px; margin-top:4px; min-width:0; color:var(--content-tertiary); font-size:9px; }
.code-line code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.metrics { padding:10px 12px 10px 0; display:flex; align-items:center; justify-content:flex-end; gap:5px; flex-wrap:wrap; color:var(--content-tertiary); font:9px var(--font-mono); max-width:360px; }
.token-chip { padding:3px 6px; border-radius:var(--radius-pill); background:var(--action-soft); color:var(--action-primary); }
.panel-actions { display:flex; gap:5px; flex-wrap:wrap; padding:0 12px 9px 15px; }
.panel-actions button { border:1px solid var(--border-subtle); border-radius:7px; padding:4px 7px; background:transparent; color:var(--content-secondary); font-size:9px; }
.panel-actions button:hover,.panel-actions button.active { background:var(--surface-raised); color:var(--content-primary); border-color:var(--border-default); }
.panel { border-top:1px solid var(--border-subtle); padding:11px 14px; background:var(--surface-raised); }
.panel-label { margin-bottom:7px; color:var(--content-tertiary); font-size:8px; letter-spacing:.1em; text-transform:uppercase; }
pre { margin:0; max-height:420px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:10px/1.58 var(--font-mono); color:var(--content-primary); }
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
</style>
