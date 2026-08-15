<template>
  <main class="design-page">
    <div class="design-inner">
      <header class="design-header">
        <div><p class="eyebrow">Runtime style laboratory</p><h1>Design Tokens</h1><p class="subtitle">按分类查看真实运行时令牌、组件样板和主题状态。</p></div>
        <ThemeSwitcher :model-value="preference" @update:model-value="setTheme" />
      </header>

      <section class="token-section" aria-labelledby="colors-title">
        <div class="section-heading"><span>01</span><h2 id="colors-title">色彩</h2></div>
        <div class="color-grid">
          <article v-for="token in colorTokens" :key="token.variable" class="color-card">
            <div class="color-swatch" :style="{ background: `var(${token.variable})` }" />
            <div class="token-card-body"><button class="copy-button" type="button" :title="copiedVariable === token.variable ? '已复制' : `复制 ${token.variable}`" :aria-label="copiedVariable === token.variable ? '已复制' : `复制 ${token.variable}`" @click.stop="handleCopy(token)"><PhCheck v-if="copiedVariable === token.variable" :size="15" weight="bold" /><PhCopy v-else :size="15" weight="bold" /></button><strong>{{ token.name }}</strong><code>{{ token.variable }}</code><small>{{ valueOf(token) }}</small></div>
          </article>
        </div>
      </section>

      <section class="token-section" aria-labelledby="type-title">
        <div class="section-heading"><span>02</span><h2 id="type-title">字体</h2></div>
        <div class="type-grid">
          <article v-for="token in fontTokens" :key="token.variable" class="sample-card type-card"><code>{{ token.variable }}</code><p :style="{ fontSize: `var(${token.variable})` }">设计令牌示例文字</p><small>{{ valueOf(token) }} · {{ token.description }}</small></article>
        </div>
      </section>

      <section class="token-section" aria-labelledby="layout-title">
        <div class="section-heading"><span>03</span><h2 id="layout-title">布局</h2></div>
        <div class="layout-grid">
          <article class="sample-card spacing-card"><div class="sample-card-heading"><strong>间距</strong><span>四档主尺度</span></div><div class="spacing-list"><div v-for="token in spaceTokens" :key="token.variable" class="spacing-row"><code>{{ token.variable }}</code><i :style="{ width: `${spacePixels(token) * 4}px` }" /><small>{{ valueOf(token) }}</small></div></div></article>
          <article class="sample-card radius-card"><div class="sample-card-heading"><strong>圆角</strong><span>四档主尺度</span></div><div class="radius-list"><div v-for="token in radiusTokens" :key="token.variable" class="radius-sample" :style="{ borderRadius: `var(${token.variable})` }"><code>{{ token.variable }}</code></div></div></article>
          <article class="sample-card shadow-card"><div class="sample-card-heading"><strong>阴影</strong><span>表面层级</span></div><div class="shadow-list"><div v-for="token in shadowTokens" :key="token.variable" class="shadow-sample" :style="{ boxShadow: `var(${token.variable})` }"><strong>{{ token.name }}</strong><code>{{ token.variable }}</code></div></div></article>
        </div>
      </section>

      <section class="token-section" aria-labelledby="components-title">
        <div class="section-heading"><span>04</span><h2 id="components-title">表面与组件</h2></div>
        <div class="component-grid">
          <article class="sample-card glass-sample"><code>--surface-glass</code><div class="glass-demo"><strong>共享玻璃表面</strong><span>面板、弹窗和普通卡片共用语义表面。</span></div></article>
          <article class="sample-card divider-sample"><code>--divider-line</code><div class="divider-demo" /><small>导航栏和页面章节共用的主题分割线。</small></article>
          <ComponentStatesPreview />
          <article class="sample-card admin-sample admin-theme"><code>admin-theme</code><div class="admin-demo"><strong>Admin 暗色表面</strong><span>Admin 独立映射 surface、content、border 和 scrollbar。</span><button type="button">配置面板</button></div></article>
        </div>
      </section>

      <section class="token-section" aria-labelledby="motion-title">
        <div class="section-heading"><span>05</span><h2 id="motion-title">动效</h2></div>
        <div class="motion-grid"><article v-for="token in motionTokens" :key="token.variable" class="sample-card motion-card"><code>{{ token.variable }}</code><div class="motion-demo" :style="{ transitionDuration: `var(${token.variable})` }">悬停查看过渡</div><small>{{ valueOf(token) }} · {{ token.description }}</small></article></div>
      </section>

      <section class="token-section" aria-labelledby="canvas-title">
        <div class="section-heading"><span>06</span><h2 id="canvas-title">画布</h2></div>
        <div class="canvas-grid"><article class="sample-card canvas-demo"><div class="dot-field"><div class="canvas-node">画布卡片</div><span class="canvas-line" /></div></article><div class="canvas-token-list"><article v-for="token in canvasTokens" :key="token.variable" class="sample-card canvas-token"><code>{{ token.variable }}</code><strong>{{ valueOf(token) }}</strong><small>{{ token.description }}</small></article></div></div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTheme } from '@/composables/useTheme'
import { useDesignTokens } from './composables/useDesignTokens'
import { tokenCatalog, type DesignToken } from './data/tokenCatalog'
import ThemeSwitcher from './components/ThemeSwitcher.vue'
import ComponentStatesPreview from './components/ComponentStatesPreview.vue'
import { PhCheck, PhCopy } from '@phosphor-icons/vue'

const { preference, setTheme } = useTheme()
const { valueOf, copyToken } = useDesignTokens()
const copiedVariable = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
const by = (predicate: (token: DesignToken) => boolean) => computed(() => tokenCatalog.filter(predicate))
const colorTokens = by(token => token.type === 'color')
const fontTokens = by(token => token.variable.startsWith('--font-size-'))
const spaceTokens = by(token => token.variable.startsWith('--space-'))
const radiusTokens = by(token => token.variable.startsWith('--radius-'))
const shadowTokens = by(token => token.type === 'shadow')
const motionTokens = by(token => token.category === 'motion')
const canvasTokens = by(token => token.category === 'canvas')

function spacePixels(token: DesignToken): number {
  const value = Number.parseFloat(valueOf(token))
  return Number.isFinite(value) ? value : 0
}

async function handleCopy(token: DesignToken) {
  const copied = await copyToken(token)
  if (!copied) return
  copiedVariable.value = token.variable
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copiedVariable.value = null }, 1600)
}
</script>

<style scoped>
.design-page { height: 100%; min-height: 0; overflow-y: auto; box-sizing: border-box; padding: 40px 32px 72px; color: var(--content-primary); background: var(--surface-page); font-family: var(--font-sans); }
.design-inner { width: min(1180px, 100%); margin: 0 auto; }
.design-header { display: flex; align-items: end; justify-content: space-between; gap: var(--space-4); padding-bottom: 28px; border-bottom: 1px solid var(--border-subtle); }
.eyebrow, .section-heading span { color: var(--content-secondary); font-size: var(--font-size-xs); letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 5px 0; font-size: 32px; line-height: 1.15; } .subtitle { color: var(--content-secondary); font-size: var(--font-size-sm); }
.token-section { position: relative; padding: 32px 0; }
.token-section::after { content: ''; position: absolute; right: 0; bottom: 0; left: 0; height: 1px; background: var(--divider-line); }
.section-heading { display: flex; align-items: baseline; gap: 10px; margin-bottom: 18px; } .section-heading h2 { margin: 0; font-size: 24px; }
.color-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-2); }
.color-card, .sample-card { min-width: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-glass); box-shadow: var(--shadow-rest); }
.color-swatch { height: 76px; border-bottom: 1px solid var(--border-subtle); } .token-card-body { position: relative; display: grid; gap: 4px; padding: 12px; } .token-card-body strong { padding-right: 28px; font-size: var(--font-size-sm); } code, small { color: var(--content-secondary); font-size: var(--font-size-xs); } .copy-button, .admin-demo button { width: max-content; border: 1px solid var(--border-subtle); border-radius: var(--radius-xs); padding: 6px; color: var(--content-secondary); background: transparent; cursor: pointer; font: inherit; } .copy-button { position: absolute; top: 10px; right: 10px; display: grid; place-items: center; } .copy-button:hover { color: var(--content-primary); background: var(--surface-glass-hover); } .admin-demo button { padding: 5px 8px; font-size: var(--font-size-xs); }
.type-grid, .motion-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-2); } .type-card, .motion-card { display: grid; gap: 12px; padding: var(--space-4); } .type-card p { min-height: 34px; margin: 0; color: var(--content-primary); }
.layout-grid, .component-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--space-2); } .layout-grid > *, .component-grid > * { grid-column: span 4; } .sample-card { padding: var(--space-4); }
.sample-card-heading { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; } .sample-card-heading span { color: var(--content-muted); font-size: var(--font-size-xs); }
.spacing-list, .radius-list, .shadow-list { display: grid; gap: 10px; } .spacing-row { display: flex; align-items: center; gap: 8px; } .spacing-row i { height: 8px; border-radius: var(--radius-pill); background: var(--action-primary); } .spacing-row small { margin-left: auto; }
.radius-list { grid-template-columns: repeat(4, 1fr); } .radius-sample { display: grid; place-items: center; min-height: 58px; border: 1px solid var(--border-strong); background: var(--surface-panel); } .radius-sample code { font-size: 10px; }
.shadow-sample { display: grid; gap: 4px; min-height: 48px; padding: 10px; border-radius: var(--radius-sm); background: var(--surface-panel); } .shadow-sample strong { font-size: var(--font-size-sm); }
.glass-demo, .admin-demo { display: grid; gap: 8px; margin-top: 16px; padding: 20px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-panel); } .glass-demo span, .admin-demo span { color: var(--content-secondary); font-size: var(--font-size-sm); }
.divider-demo { height: 1px; margin: 34px 0 14px; background: var(--divider-line); }
.motion-demo { padding: 16px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-panel); transition-property: transform, background-color; } .motion-demo:hover { transform: translateY(-3px); background: var(--surface-glass-hover); }
.canvas-grid { display: grid; grid-template-columns: 2fr 1fr; gap: var(--space-2); } .canvas-demo { padding: 0; } .dot-field { position: relative; min-height: 220px; overflow: hidden; background-color: var(--surface-panel); background-image: radial-gradient(var(--canvas-dot-color) 1px, transparent 1px); background-size: 18px 18px; } .canvas-node { position: absolute; top: 76px; left: 25%; padding: 18px 28px; border: 1px solid var(--border-strong); border-radius: var(--canvas-card-radius); background: var(--surface-card); box-shadow: var(--card-shadow); } .canvas-line { position: absolute; top: 132px; left: 43%; width: 40%; height: 1px; background: var(--canvas-connection-color); transform: rotate(-12deg); transform-origin: left; } .canvas-token-list { display: grid; gap: var(--space-2); } .canvas-token { display: grid; gap: 8px; padding: var(--space-4); }
@media (max-width: 900px) { .color-grid, .type-grid, .motion-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .layout-grid > *, .component-grid > * { grid-column: span 6; } .canvas-grid { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .design-page { padding: 24px 16px 48px; } .design-header { align-items: start; flex-direction: column; } .color-grid, .type-grid, .motion-grid { grid-template-columns: 1fr; } .layout-grid, .component-grid { grid-template-columns: 1fr; } .layout-grid > *, .component-grid > * { grid-column: auto; } }
</style>
