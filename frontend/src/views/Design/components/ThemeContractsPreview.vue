<template>
  <section class="contract-extension">
    <div class="contract-shell">
      <header class="extension-head">
        <div><span>07 · THEME CONTRACTS</span><h2>弹窗、菜单、选择胶囊与 Mind 纸面</h2></div>
        <p>这些样板直接消费真实 Component tokens；切换 Aero / Mono 与 Light / Dark 时无需页面分支。</p>
      </header>

      <div class="preview-grid surface-grid">
        <article class="preview-card">
          <div class="preview-stage panel-stage">
            <div class="panel-preview"><strong>Panel glass</strong><span>导航 / 双栏弹窗侧栏</span></div>
          </div>
          <div class="meta"><strong>Panel surface</strong><code>--panel-glass-*</code><span>panel-left / 毛玻璃侧栏</span></div>
        </article>
        <article class="preview-card">
          <div class="preview-stage modal-stage">
            <div class="modal-preview"><strong>Modal card</strong><span>统一描边、高光与窗口层级阴影</span></div>
          </div>
          <div class="meta"><strong>Modal surface</strong><code>--modal-card-*</code><span>BaseModal / 二次确认</span></div>
        </article>
        <article class="preview-card">
          <div class="preview-stage popup-stage">
            <div class="popup-preview">
              <button class="popup-preview-item">普通菜单项</button>
              <button class="popup-preview-item active">当前选项</button>
              <div class="popup-preview-sep"></div>
              <button class="popup-preview-item danger">危险操作</button>
            </div>
          </div>
          <div class="meta"><strong>Popover / menu</strong><code>--popup-*</code><span>日期 / 右键 / 排序 / 用户菜单 + motion</span></div>
        </article>
        <article class="preview-card">
          <div class="preview-stage input-stage"><input class="contract-input" value="暗色输入框也消费同一角色" /></div>
          <div class="meta"><strong>Input</strong><code>--input-*</code><span>背景 / 边框 / focus / placeholder</span></div>
        </article>
      </div>

      <div class="subhead"><div><h3>Choice capsule</h3><p>个人设置中的主题、模式、回复风格、多选工具统一调用。</p></div><code>--choice-chip-*</code></div>
      <div class="chip-demo preview-card">
        <button class="choice-chip">默认</button>
        <button class="choice-chip active">已选择</button>
        <button class="choice-chip">另一个选项</button>
      </div>

      <div class="subhead"><div><h3>Mind note palette</h3><p>Light 保留原版便签纸精确色值；Dark 使用独立暗色映射。保存的 amber / coral / blue / teal 身份不变。</p></div><code>--note-paper-*</code></div>
      <div class="note-grid">
        <article v-for="note in notes" :key="note.token" class="preview-card note-token">
          <div class="note-swatch" :style="{ background: `var(${note.token})` }"><strong>{{ note.label }}</strong><span>便签正文示例</span></div>
          <div class="meta"><code>{{ note.token }}</code><span>{{ note.note }}</span></div>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
const notes = [
  { label: 'Timeline', token: '--note-surface', note: '时间流默认纸面 · Light 原 rgba(255,255,255,.56)' },
  { label: 'Canvas', token: '--note-paper-default-canvas', note: '画布默认纸面 · Light 原暖白纸色' },
  { label: 'Amber', token: '--note-paper-amber', note: '橙色便签 · Light 原 RGB' },
  { label: 'Coral', token: '--note-paper-coral', note: '红色便签 · Light 原 RGB' },
  { label: 'Blue', token: '--note-paper-blue', note: '蓝色便签 · Light 原 RGB' },
  { label: 'Teal', token: '--note-paper-teal', note: '青色便签 · Light 原 RGB' },
]
</script>

<style scoped>
.contract-extension{background:var(--surface-page);color:var(--content-primary);font-family:var(--font-sans);padding:0 clamp(var(--space-lg),4vw,56px) 72px}.contract-shell{width:min(1328px,100%);margin:0 auto;padding:var(--space-xl);border:1px solid var(--design-section-border);border-radius:var(--design-section-radius);background:var(--design-section-bg);box-shadow:var(--design-section-shadow),inset 0 1px 0 var(--design-section-highlight)}
.extension-head{display:flex;justify-content:space-between;align-items:flex-end;gap:var(--space-xl);margin-bottom:var(--space-lg)}.extension-head>div>span{color:var(--content-tertiary);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);letter-spacing:var(--tracking-label)}.extension-head h2{margin-top:var(--space-xs);font-size:var(--font-size-lg)}.extension-head p{max-width:620px;color:var(--content-secondary);font-size:var(--font-size-sm);line-height:var(--line-height-body)}
.preview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--design-grid-gap)}.preview-card{overflow:hidden;border:1px solid var(--design-card-border);border-radius:var(--design-card-radius);background:var(--design-card-bg);box-shadow:var(--elevation-card)}.preview-stage{height:150px;display:grid;place-items:center;padding:var(--space-lg);background:var(--surface-soft);border-bottom:1px solid var(--border-hairline)}
.panel-stage{background:linear-gradient(145deg,color-mix(in srgb,var(--action-primary) 12%,var(--surface-base)),var(--surface-base))}.panel-preview{width:76%;height:104px;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-xs);background:var(--panel-glass-bg);border:1px solid var(--panel-glass-border);border-radius:var(--radius-lg);box-shadow:var(--panel-glass-shadow);backdrop-filter:var(--panel-glass-blur)}.panel-preview strong,.modal-preview strong{font-size:var(--font-size-sm)}.panel-preview span,.modal-preview span{color:var(--content-secondary);font-size:var(--font-size-xs)}
.modal-preview{width:82%;padding:var(--space-lg);display:flex;flex-direction:column;gap:var(--space-xs);background:var(--modal-card-bg);border:1px solid var(--modal-card-border);border-radius:var(--radius-lg);box-shadow:var(--modal-card-shadow),inset 0 1px 0 var(--modal-card-highlight)}.contract-input{width:90%;height:38px;padding:0 var(--space-md);border:1px solid var(--input-border);border-radius:var(--input-radius);outline:none;color:var(--input-fg);background:var(--input-bg);font:var(--font-size-sm) var(--font-sans)}.contract-input:focus{background:var(--input-bg-focus);border-color:var(--input-border-focus);box-shadow:var(--input-focus-shadow)}
.popup-preview{width:88%;padding:var(--popup-surface-padding);border:1px solid var(--popup-surface-border);border-radius:var(--popup-surface-radius);background:var(--popup-surface-bg);box-shadow:var(--popup-surface-shadow),inset 0 1px 0 var(--popup-surface-highlight)}.popup-preview-item{width:100%;padding:6px 8px;border:0;border-radius:var(--radius-xs);text-align:left;color:var(--popup-item-fg);background:transparent;font:var(--font-size-xs) var(--font-sans)}.popup-preview-item.active{color:var(--popup-item-fg-active);background:var(--popup-item-bg-active)}.popup-preview-item.danger{color:var(--popup-item-danger)}.popup-preview-item:hover{background:var(--popup-item-bg-hover)}.popup-preview-item.danger:hover{background:var(--popup-item-danger-bg-hover)}.popup-preview-sep{height:1px;margin:3px 5px;background:var(--popup-divider)}
.meta{padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-xs)}.meta strong{font-size:var(--font-size-sm)}.meta code,.subhead code{color:var(--selection-fg);font:var(--font-size-xs) var(--font-mono)}.meta span{color:var(--content-tertiary);font-size:var(--font-size-xs)}
.subhead{display:flex;align-items:end;justify-content:space-between;gap:var(--space-md);margin:var(--space-xl) 0 var(--space-md)}.subhead h3{font-size:var(--font-size-md)}.subhead p{margin-top:var(--space-xs);color:var(--content-tertiary);font-size:var(--font-size-xs)}.chip-demo{min-height:90px;display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-lg)}.choice-chip{padding:6px 14px;border:1px solid var(--choice-chip-border);border-radius:var(--choice-chip-radius);color:var(--choice-chip-fg);background:var(--choice-chip-bg);font:500 var(--font-size-sm) var(--font-sans)}.choice-chip:hover{color:var(--choice-chip-fg-hover);background:var(--choice-chip-bg-hover);border-color:var(--choice-chip-border-hover)}.choice-chip.active{color:var(--choice-chip-fg-active);background:var(--choice-chip-bg-active);border-color:var(--choice-chip-border-active);font-weight:600}
.note-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:var(--design-grid-gap)}.note-swatch{height:118px;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-sm);border-bottom:1px solid var(--border-hairline)}.note-swatch strong{font-size:var(--font-size-md)}.note-swatch span{color:var(--content-secondary);font-size:var(--font-size-sm)}
@media(max-width:1180px){.preview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.note-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:760px){.preview-grid{grid-template-columns:1fr}.note-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.extension-head{align-items:flex-start;flex-direction:column}}@media(max-width:520px){.note-grid{grid-template-columns:1fr}.contract-shell{padding:var(--space-lg)}}
</style>
