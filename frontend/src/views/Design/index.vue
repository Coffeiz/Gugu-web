<template>
  <main class="design-page">
    <header class="design-header">
      <div>
        <p class="eyebrow">Runtime style laboratory</p>
        <h1>Design Tokens</h1>
        <p class="subtitle">读取当前运行时令牌，验证主题、尺度和共享表面。</p>
      </div>
      <ThemeSwitcher :model-value="preference" @update:model-value="setTheme" />
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
      <ComponentStatesPreview />
    </section>

    <PrimitiveTokenPreview />

    <TokenSection v-for="group in groupNames" :key="group" :title="group" :tokens="grouped[group]" :value-of="valueOf" @copy="copyToken" />

    <section class="admin-preview admin-theme">
      <span class="preview-label">admin</span><h2>Admin 暗色语义预览</h2><p>Admin 使用独立的 surface、content、border 和 scrollbar 映射。</p>
      <div class="admin-sample"><strong>配置面板</strong><span>独立暗色主题不会跟随主应用主题语义串线。</span></div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useTheme } from '@/composables/useTheme'
import { useDesignTokens } from './composables/useDesignTokens'
import type { DesignToken } from './data/tokenCatalog'
import ThemeSwitcher from './components/ThemeSwitcher.vue'
import TokenSection from './components/TokenSection.vue'
import ComponentStatesPreview from './components/ComponentStatesPreview.vue'
import PrimitiveTokenPreview from './components/PrimitiveTokenPreview.vue'

const { preference, setTheme } = useTheme()
const { tokens, valueOf, copyToken } = useDesignTokens()
const groups = ['primitive', 'semantic', 'component', 'motion', 'canvas'] as const
const groupLabels: Record<string, string> = { primitive: '基础', semantic: '语义', component: '组件', motion: '动效', canvas: '画布' }
const groupNames = groups.map(group => groupLabels[group])
const grouped = computed(() => Object.fromEntries(groups.map(group => [groupLabels[group], tokens.value.filter(token => token.category === group)])) as Record<string, DesignToken[]>)
const scalePreview = [
  { name: 'space', value: '24%' }, { name: 'font', value: '42%' }, { name: 'radius', value: '66%' }, { name: 'motion', value: '90%' },
]
</script>

<style scoped>
.design-page { height: 100%; min-height: 0; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; padding: 40px clamp(24px, 6vw, 96px) 72px; color: var(--content-primary); background: var(--surface-page); font-family: var(--font-sans); }
.design-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; max-width: 1180px; margin: 0 auto 28px; }
.eyebrow, .preview-label { color: var(--content-secondary); font-size: var(--font-size-xs); letter-spacing: .12em; text-transform: uppercase; }
h1 { margin-top: 5px; font-size: 32px; line-height: 1.15; } h2 { font-size: var(--font-size-lg); }
.subtitle, .preview-card p { margin-top: 8px; color: var(--content-secondary); font-size: var(--font-size-sm); }
.preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); max-width: 1180px; margin: 0 auto 36px; }
.preview-card { min-height: 168px; padding: var(--space-4); } .sample-row { display: flex; gap: var(--space-2); margin-top: 24px; }
.sample-chip { padding: 8px 12px; border-radius: var(--radius-pill); background: var(--surface-panel); font-size: var(--font-size-sm); } .sample-chip.accent { color: var(--content-on-accent); background: var(--action-primary); } .sample-chip.success { color: var(--content-on-accent); background: var(--status-success); }
.scale-list { display: grid; gap: 10px; margin-top: 18px; } .scale-list div { display: flex; align-items: center; gap: 10px; color: var(--content-secondary); font-size: var(--font-size-sm); } .scale-list i { display: block; height: 8px; border-radius: var(--radius-pill); background: var(--action-primary); }
.admin-preview { max-width: 1180px; margin: 0 auto; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-panel); color: var(--content-primary); }
.admin-preview h2 { margin-top: 5px; font-size: var(--font-size-lg); } .admin-preview p { margin-top: 8px; color: var(--content-secondary); font-size: var(--font-size-sm); } .admin-sample { display: grid; gap: 4px; margin-top: 18px; padding: 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); } .admin-sample span { color: var(--content-secondary); font-size: var(--font-size-sm); }
@media (max-width: 760px) { .design-header, .preview-grid { grid-template-columns: 1fr; display: grid; } .design-header { align-items: start; } }
</style>
