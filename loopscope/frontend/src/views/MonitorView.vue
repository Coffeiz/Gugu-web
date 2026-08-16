<template>
  <div class="monitor">
    <header class="top">
      <div>
        <RouterLink to="/" class="back">← Conversation</RouterLink>
        <span class="eyebrow">SESSION #{{ sessionId }}</span>
        <h1>Agent loop monitor</h1>
      </div>
      <button class="ls-button" @click="reload">Refresh</button>
    </header>

    <div class="monitor-grid">
      <aside class="runs">
        <span class="eyebrow">RUNS</span>
        <button v-for="run in runs" :key="run.id" :class="{active: run.id===selected?.id}" @click="selectRun(run.id)">
          <span class="status" :data-status="run.status"></span>
          <span><b>{{ run.id }}</b><small>{{ new Date(run.started_at*1000).toLocaleTimeString() }}</small></span>
          <em>{{ fmtMs(run.duration_ms) }}</em>
        </button>
      </aside>

      <section class="trace">
        <div v-if="!selected" class="empty">这个 Session 还没有 Scope trace。</div>
        <template v-else>
          <div class="run-meta ls-card">
            <div><span class="eyebrow">RUN</span><strong>{{ selected.id }}</strong></div>
            <div><span>trace</span><code>{{ selected.trace_id || '—' }}</code></div>
            <div><span>duration</span><b>{{ fmtMs(selected.duration_ms) }}</b></div>
            <div><span>tokens</span><b>{{ tokenText }}</b></div>
          </div>

          <div class="loop">
            <details v-for="span in selected.spans" :key="span.id" class="span ls-card">
              <summary>
                <span class="rail" :data-kind="span.kind"></span>
                <span class="kind">{{ span.kind }}</span>
                <strong>{{ span.name }}</strong>
                <span class="duration">{{ fmtMs(span.duration_ms) }}</span>
                <span class="chev">⌄</span>
              </summary>
              <div class="span-body">
                <section>
                  <h3>Input</h3>
                  <pre>{{ pretty(span.input) }}</pre>
                </section>
                <section>
                  <h3>Output</h3>
                  <pre>{{ pretty(span.output) }}</pre>
                </section>
                <section>
                  <h3>Attributes</h3>
                  <pre>{{ pretty(span.attributes) }}</pre>
                </section>
              </div>
            </details>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { TraceRun } from '../types'
import { getRun, listRuns } from '../services/api'
const route=useRoute()
const sessionId=String(route.params.sessionId)
const runs=ref<TraceRun[]>([])
const selected=ref<TraceRun|null>(null)
async function reload(){
  runs.value=await listRuns(sessionId).catch(()=>[])
  if(runs.value.length) await selectRun(selected.value?.id || runs.value[runs.value.length-1].id)
}
async function selectRun(id:string){ selected.value=await getRun(id) }
function fmtMs(v:number|null|undefined){ return v==null?'—':`${Math.round(v)}ms` }
function pretty(v:unknown){ if(v==null)return '—'; return typeof v==='string'?v:JSON.stringify(v,null,2) }
const tokenText=computed(()=>{
  const t=selected.value?.attributes?.tokens
  return t ? `${t.input ?? 0} in / ${t.output ?? 0} out` : '—'
})
onMounted(reload)
</script>

<style scoped>
.monitor { min-height:100vh; }
.top { height:86px; padding:18px 26px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--border-subtle); }
.top h1 { margin:2px 0 0; font-size:18px; }
.back { text-decoration:none; color:var(--action-primary); font-size:10px; margin-right:10px; }
.eyebrow { font-size:9px; letter-spacing:.12em; color:var(--content-tertiary); }
.monitor-grid { display:grid; grid-template-columns:230px minmax(0,1fr); min-height:calc(100vh - 86px); }
.runs { padding:18px 12px; border-right:1px solid var(--border-subtle); }
.runs button { width:100%; border:1px solid transparent; background:transparent; border-radius:10px; display:grid; grid-template-columns:auto 1fr auto; gap:8px; text-align:left; padding:9px; align-items:center; }
.runs button:hover,.runs button.active{background:var(--surface-card); border-color:var(--border-subtle);}
.runs b{display:block;font:10px var(--font-mono);font-weight:600}.runs small{display:block;color:var(--content-tertiary);font-size:9px;margin-top:2px}.runs em{font-style:normal;color:var(--content-tertiary);font-size:9px}
.status{width:7px;height:7px;border-radius:50%;background:var(--status-success)}.status[data-status="error"]{background:var(--status-danger)}
.trace { padding:22px; overflow:hidden; }
.run-meta { display:grid; grid-template-columns:1.5fr 1fr .7fr 1fr; gap:18px; padding:14px 16px; margin-bottom:18px; }
.run-meta span { display:block; font-size:9px; color:var(--content-tertiary); margin-bottom:3px; }.run-meta strong,.run-meta code,.run-meta b{font-size:11px}
.loop { display:grid; gap:8px; max-width:980px; }
.span { overflow:hidden; }
.span summary { list-style:none; display:grid; grid-template-columns:4px 72px 1fr auto 18px; align-items:center; gap:10px; min-height:46px; padding:0 12px 0 0; cursor:pointer; }
.span summary::-webkit-details-marker{display:none}
.rail { height:100%; background:var(--trace-context); }
.rail[data-kind="llm"]{background:var(--trace-llm)}.rail[data-kind="tool"]{background:var(--trace-tool)}.rail[data-kind="guard"]{background:var(--trace-guard)}.rail[data-kind="context"]{background:var(--trace-context)}.rail[data-kind="output"]{background:var(--trace-output)}
.kind { text-transform:uppercase; font:9px var(--font-mono); color:var(--content-tertiary); }
.span strong{font-size:12px}.duration{font:10px var(--font-mono);color:var(--content-tertiary)}
.span-body { border-top:1px solid var(--border-subtle); display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--border-subtle); }
.span-body section { background:var(--surface-raised); padding:12px; min-width:0; }
.span-body section:last-child{grid-column:1/-1}
.span-body h3{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--content-tertiary);margin:0 0 7px}
pre{margin:0;white-space:pre-wrap;overflow:auto;max-height:360px;font-size:10px;line-height:1.55}
.empty{padding:60px;color:var(--content-secondary);text-align:center}
</style>
