<template>
  <div class="tokens">
    <header><span class="eyebrow">LOOPSCOPE DESIGN SYSTEM</span><h1>{{ t('nav.tokens') }}</h1><p>{{ t('tokens.description') }}</p></header>

    <section>
      <h2>{{ t('tokens.traceSemantics') }}</h2>
      <div class="trace-grid">
        <div v-for="item in trace" :key="item.name" class="swatch ls-card">
          <i :style="{background:`var(${item.var})`}"></i><b>{{ item.name }}</b><code>{{ item.var }}</code>
        </div>
      </div>
    </section>

    <section>
      <h2>{{ t('tokens.surfaces') }}</h2>
      <div class="surface-grid">
        <div class="sample page">{{ t('tokens.page') }}</div><div class="sample panel">{{ t('tokens.panel') }}</div><div class="sample card">{{ t('tokens.card') }}</div><div class="sample raised">{{ t('tokens.raised') }}</div>
      </div>
      <div class="text-samples"><strong>{{ t('tokens.primaryContent') }}</strong><span>{{ t('tokens.secondaryContent') }}</span><small>{{ t('tokens.tertiaryContent') }}</small></div>
    </section>

    <section>
      <h2>{{ t('tokens.listOverlay') }}</h2>
      <p class="section-note">{{ t('tokens.listOverlayDescription') }}</p>
      <div class="list-demo-wrap">
        <button class="list-trigger" :aria-expanded="listOpen" @click="listOpen = !listOpen">
          {{ t('tokens.sampleOption') }} <FlipChevron :open="listOpen" :size="10" />
        </button>
        <div class="list-overlay-demo" :class="{ open: listOpen }">
          <button class="list-option" @click="listOpen = false">{{ t('tokens.sampleOption') }} <FlipChevron :open="false" :size="10" /></button>
          <button class="list-option selected" @click="listOpen = false">{{ t('tokens.sampleOptionSelected') }} <span>✓</span></button>
        </div>
      </div>
    </section>

    <section>
      <h2>{{ t('tokens.typography') }}</h2>
      <div class="type-grid">
        <div v-for="s in sizes" :key="s"><code>{{ s }}</code><p :style="{fontSize:`var(${s})`}">{{ t('tokens.exampleText') }}</p></div>
      </div>
    </section>

    <section>
      <h2>{{ t('tokens.spacingRadius') }}</h2>
      <div class="metric-row"><div v-for="s in spaces" :key="s"><i :style="{width:`var(${s})`}"></i><code>{{ s }}</code></div></div>
      <div class="radius-row"><div v-for="r in radii" :key="r" :style="{borderRadius:`var(${r})`}"><code>{{ r }}</code></div></div>
    </section>

    <section>
      <h2>{{ t('tokens.elevationMotion') }}</h2>
      <div class="elevation-row">
        <div class="elev e1">{{ t('tokens.card') }}</div><div class="elev e2">Hover</div><div class="elev e3">{{ t('tokens.popup') }}</div>
        <button class="motion-sample">{{ t('tokens.hoverMotion') }}</button>
      </div>
      <div class="motion-meta"><code>--motion-hover-micro</code><code>--motion-hover-control</code><code>--motion-hover-card</code><code>--motion-ease-standard</code></div>
    </section>

    <section>
      <h2>{{ t('tokens.controlsStates') }}</h2>
      <div class="controls">
        <button class="ls-button">{{ t('tokens.default') }}</button><button class="ls-button primary">{{ t('tokens.primary') }}</button>
        <input :placeholder="t('tokens.search')" /><span class="status success">{{ t('tokens.success') }}</span><span class="status warning">{{ t('tokens.warning') }}</span><span class="status danger">{{ t('tokens.error') }}</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import FlipChevron from '../components/FlipChevron.vue'
import { useLoopScopeI18n } from '../i18n/index'
const { t } = useLoopScopeI18n()
const listOpen = ref(true)
const trace=[
  {name:'Input',var:'--trace-input'},{name:'Context',var:'--trace-context'},{name:'LLM',var:'--trace-llm'},
  {name:'Tool',var:'--trace-tool'},{name:'Guard',var:'--trace-guard'},{name:'Output',var:'--trace-output'},
  {name:'Database',var:'--trace-database'},{name:'Prompt file',var:'--trace-file'},{name:'Memory',var:'--trace-memory'},
  {name:'History',var:'--trace-history'},{name:'Cache',var:'--trace-cache'},{name:'State',var:'--trace-state'},
  {name:'Error',var:'--trace-error'},{name:'Running',var:'--trace-running'},
]
const sizes=['--font-size-xs','--font-size-sm','--font-size-md','--font-size-lg','--font-size-xl']
const spaces=['--space-xs','--space-sm','--space-md','--space-lg','--space-xl']
const radii=['--radius-xs','--radius-sm','--radius-md','--radius-lg','--radius-pill']
</script>

<style scoped>
.tokens{max-width:1060px;margin:0 auto;padding:42px 36px 80px}.eyebrow{font-size:9px;letter-spacing:.13em;color:var(--content-tertiary)}header h1{margin:4px 0;font-size:26px}header p{color:var(--content-secondary);font-size:12px}
section{margin-top:38px}h2{font-size:12px;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em;color:var(--content-secondary)}
.section-note{margin:-4px 0 14px;color:var(--content-secondary);font-size:11px}
.list-demo-wrap{position:relative;min-height:118px;padding:10px 0}
.list-trigger{min-width:190px;display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--surface-raised);color:var(--content-primary);font-size:11px}
.list-overlay-demo{width:190px;margin-top:6px;padding:5px;border:1px solid var(--border-list-overlay);border-radius:var(--radius-list-overlay);background:var(--surface-list-overlay);box-shadow:var(--elevation-list-overlay);transition:opacity var(--motion-fast),transform var(--motion-fast);transform-origin:top;}
.list-overlay-demo:not(.open){opacity:.55;transform:scaleY(.94)}
.list-option{width:100%;min-height:32px;display:flex;align-items:center;justify-content:space-between;padding:0 9px;border:0;border-radius:var(--radius-xs);background:transparent;color:var(--content-secondary);text-align:left;font-size:11px}
.list-option:hover,.list-option.selected{background:var(--surface-list-option-hover);color:var(--content-primary)}
.list-option.selected>span{color:var(--action-primary)}
.trace-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}.swatch{padding:10px;display:grid;grid-template-columns:26px 1fr;gap:4px 9px;align-items:center}.swatch i{width:26px;height:26px;border-radius:8px;grid-row:1/3}.swatch b{font-size:11px}.swatch code{font-size:8px;color:var(--content-tertiary)}
.surface-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}.sample{min-height:90px;border:1px solid var(--border-subtle);border-radius:var(--radius-md);display:grid;place-items:center;font-size:10px}.page{background:var(--surface-page)}.panel{background:var(--surface-panel)}.card{background:var(--surface-card)}.raised{background:var(--surface-raised);box-shadow:var(--elevation-card)}
.text-samples{display:flex;gap:18px;margin-top:12px;align-items:baseline}.text-samples span{color:var(--content-secondary)}.text-samples small{color:var(--content-tertiary)}
.type-grid{display:grid;gap:6px}.type-grid div{display:grid;grid-template-columns:130px 1fr;align-items:baseline}.type-grid code,.metric-row code,.radius-row code{font-size:9px;color:var(--content-tertiary)}.type-grid p{margin:0}
.metric-row,.radius-row,.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.metric-row>div{height:48px;display:flex;align-items:end;gap:5px}.metric-row i{height:24px;background:var(--iris-300);border-radius:3px}
.radius-row{margin-top:18px}.radius-row>div{width:110px;height:64px;background:var(--surface-raised);border:1px solid var(--border-default);display:grid;place-items:center}
.elevation-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.elev,.motion-sample{width:116px;height:64px;border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--surface-raised);display:grid;place-items:center;font-size:10px}.e1{box-shadow:var(--elevation-card)}.e2{box-shadow:var(--elevation-card-hover)}.e3{box-shadow:var(--elevation-popup)}.motion-sample{transition:transform var(--motion-hover-control) var(--motion-ease-standard),box-shadow var(--motion-hover-control) var(--motion-ease-standard)}.motion-sample:hover{transform:translateY(-3px);box-shadow:var(--elevation-card-hover)}.motion-meta{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px}.motion-meta code{font-size:9px;color:var(--content-tertiary)}
.controls input{min-height:36px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);padding:0 10px;background:var(--surface-raised)}.status{padding:6px 9px;border-radius:var(--radius-pill);font-size:10px}.success{color:var(--status-success);background:color-mix(in srgb,var(--status-success) 12%,transparent)}.warning{color:var(--status-warning);background:color-mix(in srgb,var(--status-warning) 12%,transparent)}.danger{color:var(--status-danger);background:color-mix(in srgb,var(--status-danger) 12%,transparent)}
</style>
