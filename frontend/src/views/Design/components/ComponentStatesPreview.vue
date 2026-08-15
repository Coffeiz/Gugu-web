<template>
  <article class="preview-card glass-card">
    <span class="preview-label">states</span><h2>组件状态</h2>
    <div class="state-row"><button>默认</button><button class="hover">悬停</button><button class="active">按下</button><button disabled>禁用</button></div>
    <div class="state-card"><strong>项目卡片</strong><span>普通业务组件沿用同一套 surface 与 motion 令牌。</span></div>
  </article>
</template>

<style scoped>
.preview-card { min-height: 168px; padding: var(--space-4); } .preview-label { color: var(--content-secondary); font-size: var(--font-size-xs); letter-spacing: .12em; text-transform: uppercase; } h2 { margin-top: 5px; font-size: var(--font-size-lg); }
.state-row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 18px 0; } button { border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 8px 12px; color: var(--content-primary); background: var(--surface-glass); cursor: pointer; font: inherit; font-size: var(--font-size-sm); transition: background var(--motion-default) var(--motion-ease-standard), transform var(--motion-default) var(--motion-ease-emphasis); } button.hover, button:hover:not(:disabled) { background: var(--surface-glass-hover); transform: translateY(-2px); } button.active { transform: translateY(1px); opacity: .9; } button:disabled { opacity: .45; cursor: not-allowed; }
.state-card { display: grid; gap: 4px; padding: 12px; border-radius: var(--card-radius); background: var(--surface-card); box-shadow: var(--card-shadow); } .state-card span { color: var(--content-secondary); font-size: var(--font-size-sm); }
</style>
