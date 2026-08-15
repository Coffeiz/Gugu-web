<template>
  <section class="primitive-preview">
    <div class="primitive-heading">
      <div>
        <span class="preview-label">primitive</span>
        <h2>基础令牌参考案例</h2>
      </div>
      <span class="primitive-note">所有样例直接读取运行时 CSS 变量</span>
    </div>

    <div class="primitive-grid">
      <article class="primitive-card primitive-card--wide">
        <h3>颜色</h3>
        <div class="color-list">
          <div v-for="item in colors" :key="item.variable" class="color-item">
            <i :style="{ background: `var(${item.variable})` }" />
            <span>{{ item.name }}</span>
            <code>{{ item.variable }}</code>
          </div>
        </div>
      </article>

      <article class="primitive-card primitive-card--wide">
        <h3>间距</h3>
        <div class="space-list">
          <div v-for="item in spaces" :key="item.variable" class="space-item">
            <code>{{ item.variable }}</code>
            <i :style="{ width: `${spacePixels(item.variable) * 4}px` }" />
            <output>{{ valueOf(item.variable) }}</output>
          </div>
        </div>
      </article>

      <article class="primitive-card primitive-card--half">
        <h3>字号</h3>
        <div class="font-list">
          <div v-for="item in fonts" :key="item.variable" class="font-item" :style="{ fontSize: `var(${item.variable})` }">
            <code>{{ item.variable }}</code><span>设计令牌示例文字</span><output>{{ valueOf(item.variable) }}</output>
          </div>
        </div>
      </article>

      <article class="primitive-card primitive-card--half">
        <h3>圆角与阴影</h3>
        <div class="radius-list">
          <div v-for="item in radii" :key="item.variable" class="radius-item" :style="{ borderRadius: `var(${item.variable})` }">
            <code>{{ item.variable }}</code>
          </div>
        </div>
        <div class="shadow-list">
          <div v-for="item in shadows" :key="item.variable" class="shadow-item" :style="{ boxShadow: `var(${item.variable})` }">
            <code>{{ item.name }}</code>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
const colors = [
  { name: '紫色 500', variable: '--palette-purple-500' },
  { name: '紫色 400', variable: '--palette-purple-400' },
  { name: '粉色 400', variable: '--palette-pink-400' },
  { name: '青色 400', variable: '--palette-cyan-400' },
  { name: '灰色 050', variable: '--palette-gray-050' },
  { name: '灰色 100', variable: '--palette-gray-100' },
  { name: '灰色 300', variable: '--palette-gray-300' },
  { name: '灰色 900', variable: '--palette-gray-900' },
  { name: '白色 α08', variable: '--alpha-white-08' },
  { name: '白色 α38', variable: '--alpha-white-38' },
  { name: '白色 α56', variable: '--alpha-white-56' },
  { name: '白色 α70', variable: '--alpha-white-70' },
  { name: '白色 α76', variable: '--alpha-white-76' },
  { name: '黑色 α08', variable: '--alpha-black-08' },
]
const spaces = [1, 2, 3, 4].map(index => ({ variable: `--space-${index}` }))
const fonts = ['xs', 'sm', 'md', 'lg'].map(size => ({ variable: `--font-size-${size}` }))
const radii = ['xs', 'sm', 'md', 'lg'].map(size => ({ variable: `--radius-${size}` }))
const shadows = [
  { name: '静止', variable: '--shadow-rest' },
  { name: '悬停', variable: '--shadow-hover' },
  { name: '弹层', variable: '--shadow-popup' },
]

function valueOf(variable: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || '未定义'
}

function spacePixels(variable: string): number {
  const value = Number.parseFloat(valueOf(variable))
  return Number.isFinite(value) ? value : 0
}
</script>

<style scoped>
.primitive-preview { max-width: 1320px; margin: 0 auto 36px; }
.primitive-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 12px; }
.primitive-heading h2 { margin-top: 5px; font-size: var(--font-size-lg); }
.primitive-note { color: var(--content-muted); font-size: var(--font-size-xs); }
.primitive-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--space-2); }
.primitive-card { min-width: 0; padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-glass); }
.primitive-card--wide { grid-column: span 12; }
.primitive-card--half { grid-column: span 6; }
.primitive-card h3 { margin-bottom: 14px; font-size: var(--font-size-md); }
.color-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-2); }
.space-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
.font-list, .radius-list, .shadow-list { display: grid; gap: var(--space-2); }
.color-item, .space-item, .font-item { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--content-secondary); }
.color-item i { width: 24px; height: 24px; flex: 0 0 auto; border: 1px solid var(--border-subtle); border-radius: var(--radius-xs); }
.color-item span { min-width: 70px; color: var(--content-primary); font-size: var(--font-size-sm); }
code, output { color: var(--content-secondary); font-size: var(--font-size-xs); }
.color-item code, .font-item code { margin-left: auto; }
.space-item i { display: block; flex: 0 0 auto; height: 9px; border-radius: var(--radius-pill); background: var(--action-primary); }
.space-item output { margin-left: auto; }
.font-item { min-height: 27px; }
.font-item span { color: var(--content-primary); }
.font-item output { margin-left: auto; }
.radius-list { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 16px; }
.radius-item { display: grid; place-items: center; min-height: 48px; border: 1px solid var(--border-strong); background: var(--surface-panel); }
.radius-item code { font-size: 10px; }
.shadow-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.shadow-item { display: grid; place-items: center; min-height: 58px; border-radius: var(--radius-sm); background: var(--surface-panel); }
.shadow-item code { color: var(--content-primary); }
@media (max-width: 900px) { .space-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } .primitive-card--half { grid-column: span 12; } }
@media (max-width: 760px) { .primitive-heading { align-items: start; flex-direction: column; gap: 6px; } .primitive-grid { display: grid; grid-template-columns: 1fr; } .primitive-card--wide, .primitive-card--half { grid-column: auto; } .space-list { grid-template-columns: 1fr; } }
</style>
