<template>
  <main class="design-page">
    <header class="design-header">
      <div>
        <p class="eyebrow">Runtime style laboratory</p>
        <h1>Design Tokens</h1>
        <p class="subtitle">读取当前运行时令牌，验证主题、尺度和共享表面。</p>
      </div>
      <div class="theme-switcher" aria-label="主题切换">
        <button v-for="item in themes" :key="item.value" :class="{ active: preference === item.value }" @click="setTheme(item.value)">{{ item.label }}</button>
      </div>
    </header>

    <section class="preview-grid">
      <article class="preview-card glass-card">
        <span class="preview-label">surface</span>
        <h2>共享玻璃表面</h2>
        <p>主应用面板、弹窗与普通卡片从语义层读取表面值。</p>
        <div class="sample-row"><span class="sample-chip">默认</span><span class="sample-chip accent">强调</span><span class="sample-chip success">完成</span></div>
      </article>
      <article class="preview-card glass-card">
        <span class="preview-label">scale</span>
        <h2>四档尺度</h2>
        <div class="scale-list"><div v-for="item in scalePreview" :key="item.name"><span>{{ item.name }}</span><i :style="{ width: item.value }" /></div></div>
      </article>
    </section>

    <section v-for="group in groupNames" :key="group" class="token-section">
      <div class="section-heading"><h2>{{ group }}</h2><span>{{ grouped[group].length }} tokens</span></div>
      <div class="token-grid">
        <article v-for="token in grouped[group]" :key="token.variable" class="token-row">
          <div class="token-swatch" :style="swatchStyle(token)" />
          <div class="token-copy"><strong>{{ token.name }}</strong><code>{{ token.variable }}</code><small>{{ token.description }}</small></div>
          <button class="copy-button" :title="`复制 ${token.variable}`" @click="copyToken(token)">复制</button>
          <output>{{ valueOf(token) }}</output>
        </article>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useTheme, type ThemePreference } from '@/composables/useTheme'
import { useDesignTokens } from './composables/useDesignTokens'
import type { DesignToken } from './data/tokenCatalog'

const { preference, setTheme } = useTheme()
const { tokens, valueOf, copyToken } = useDesignTokens()
const themes: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' },
]
const groups = ['primitive', 'semantic', 'component', 'motion', 'canvas'] as const
const groupLabels: Record<string, string> = { primitive: '基础', semantic: '语义', component: '组件', motion: '动效', canvas: '画布' }
const groupNames = groups.map(group => groupLabels[group])
const grouped = computed(() => Object.fromEntries(groups.map(group => [groupLabels[group], tokens.value.filter(token => token.category === group)])) as Record<string, DesignToken[]>)
const scalePreview = [
  { name: 'space', value: '24%' }, { name: 'font', value: '42%' }, { name: 'radius', value: '66%' }, { name: 'motion', value: '90%' },
]
function swatchStyle(token: DesignToken) {
  return token.type === 'color' ? { background: `var(${token.variable})` } : token.type === 'shadow' ? { boxShadow: `var(${token.variable})` } : {}
}
</script>

<style scoped>
.design-page { min-height: 100vh; overflow: auto; padding: 40px clamp(24px, 6vw, 96px) 72px; color: var(--content-primary); background: var(--surface-page); font-family: var(--font-sans); }
.design-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; max-width: 1180px; margin: 0 auto 28px; }
.eyebrow, .preview-label { color: var(--content-secondary); font-size: var(--font-size-xs); letter-spacing: .12em; text-transform: uppercase; }
h1 { margin-top: 5px; font-size: 32px; line-height: 1.15; } h2 { font-size: var(--font-size-lg); }
.subtitle, .preview-card p { margin-top: 8px; color: var(--content-secondary); font-size: var(--font-size-sm); }
.theme-switcher { display: flex; gap: var(--space-1); padding: var(--space-1); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); }
.theme-switcher button, .copy-button { border: 0; border-radius: var(--radius-xs); padding: 7px 10px; color: var(--content-secondary); background: transparent; cursor: pointer; font: inherit; font-size: var(--font-size-sm); }
.theme-switcher button.active, .theme-switcher button:hover, .copy-button:hover { color: var(--content-primary); background: var(--surface-glass-hover); }
.preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); max-width: 1180px; margin: 0 auto 36px; }
.preview-card { min-height: 168px; padding: var(--space-4); } .sample-row { display: flex; gap: var(--space-2); margin-top: 24px; }
.sample-chip { padding: 8px 12px; border-radius: var(--radius-pill); background: var(--surface-panel); font-size: var(--font-size-sm); } .sample-chip.accent { color: var(--content-on-accent); background: var(--action-primary); } .sample-chip.success { color: var(--content-on-accent); background: var(--status-success); }
.scale-list { display: grid; gap: 10px; margin-top: 18px; } .scale-list div { display: flex; align-items: center; gap: 10px; color: var(--content-secondary); font-size: var(--font-size-sm); } .scale-list i { display: block; height: 8px; border-radius: var(--radius-pill); background: var(--action-primary); }
.token-section { max-width: 1180px; margin: 0 auto 28px; } .section-heading { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; } .section-heading span { color: var(--content-muted); font-size: var(--font-size-xs); }
.token-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
.token-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); }
.token-swatch { width: 26px; height: 26px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); background: var(--surface-panel); } .token-copy { min-width: 0; display: grid; gap: 2px; } .token-copy strong { font-size: var(--font-size-sm); } .token-copy code, output { color: var(--content-secondary); font-size: var(--font-size-xs); } .token-copy small { color: var(--content-muted); font-size: var(--font-size-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
output { max-width: 190px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .copy-button { border: 1px solid var(--border-subtle); }
@media (max-width: 760px) { .design-header, .preview-grid, .token-grid { grid-template-columns: 1fr; display: grid; } .design-header { align-items: start; } .theme-switcher { width: fit-content; } .token-row { grid-template-columns: 28px minmax(0, 1fr); } .token-row output, .token-row .copy-button { grid-column: 2; text-align: left; } }
</style>
