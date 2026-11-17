<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'

defineProps<{ activeSection: string; connected: boolean; compact: boolean; width: number; minWidth: number; maxWidth: number }>()
const emit = defineEmits<{
  navigate: [section: string]
  resizeStart: [event: PointerEvent]
  resize: [event: PointerEvent]
  resizeFinish: []
  resizeKeydown: [event: KeyboardEvent]
}>()
</script>

<template>
  <aside class="desktop-sidebar" :class="{ 'is-compact': compact }" aria-label="主导航">
    <nav>
      <div class="nav-group">
        <span class="nav-group-label">工作区</span>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'projects' }" aria-label="项目" @click="emit('navigate', 'projects')"><Icon name="navigation.projects" size="sm" /><span class="nav-label">项目</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'calendar' }" aria-label="日历" @click="emit('navigate', 'calendar')"><Icon name="navigation.calendar" size="sm" /><span class="nav-label">日历</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'notes' }" aria-label="笔记" @click="emit('navigate', 'notes')"><Icon name="canvas.note" size="sm" /><span class="nav-label">笔记</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'canvases' }" aria-label="画布" @click="emit('navigate', 'canvases')"><Icon name="canvas.graph" size="sm" /><span class="nav-label">画布</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'schedules' }" aria-label="定时任务" @click="emit('navigate', 'schedules')"><Icon name="admin.alarm" size="sm" /><span class="nav-label">定时任务</span></button>
      </div>
      <div class="nav-group">
        <span class="nav-group-label">资源</span>
        <button type="button" class="nav-item nav-item-disabled" :class="{ active: activeSection === 'files' }" aria-label="文件库" @click="emit('navigate', 'files')"><Icon name="file.folder" size="sm" /><span class="nav-label">文件库</span></button>
        <button type="button" class="nav-item nav-item-disabled" :class="{ active: activeSection === 'terminals' }" aria-label="终端" @click="emit('navigate', 'terminals')"><Icon name="admin.terminal" size="sm" /><span class="nav-label">终端</span></button>
        <button type="button" class="nav-item nav-item-disabled" :class="{ active: activeSection === 'skills' }" aria-label="技能" @click="emit('navigate', 'skills')"><Icon name="resource.skill" size="sm" /><span class="nav-label">技能</span></button>
        <button type="button" class="nav-item nav-item-disabled" :class="{ active: activeSection === 'mcp' }" aria-label="MCP" @click="emit('navigate', 'mcp')"><Icon name="resource.mcp" size="sm" /><span class="nav-label">MCP</span></button>
      </div>
      <div class="nav-group">
        <span class="nav-group-label">联系</span>
        <button type="button" class="nav-item nav-item-disabled" :class="{ active: activeSection === 'contacts' }" aria-label="联系人" @click="emit('navigate', 'contacts')"><Icon name="communication.customer" size="sm" /><span class="nav-label">联系人</span></button>
        <button type="button" class="nav-item nav-item-disabled" :class="{ active: activeSection === 'team' }" aria-label="团队" @click="emit('navigate', 'team')"><Icon name="communication.team" size="sm" /><span class="nav-label">团队</span></button>
      </div>
      <div class="nav-group">
        <span class="nav-group-label">通知</span>
        <button type="button" class="nav-item nav-item-disabled" :class="{ active: activeSection === 'notifications' }" aria-label="通知" @click="emit('navigate', 'notifications')"><Icon name="admin.bell" size="sm" /><span class="nav-label">通知</span></button>
      </div>
      <div class="nav-group dev-nav-group">
        <span class="nav-group-label">开发测试</span>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'home' }" aria-label="工作台（开发测试）" @click="emit('navigate', 'home')"><Icon name="navigation.grid" size="sm" /><span class="nav-label">工作台</span></button>
      </div>
    </nav>
    <div class="sidebar-footer"><span class="connection-dot" :class="{ connected }"></span><span class="connection-label">{{ connected ? 'Core 已连接' : '连接中' }}</span></div>
    <button class="sidebar-resize" type="button" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" title="拖动调整导航宽度，方向键微调" :aria-valuemin="minWidth" :aria-valuemax="maxWidth" :aria-valuenow="Math.round(width)" :aria-valuetext="compact ? '缩略导航' : `导航宽度 ${Math.round(width)} 像素`" @pointerdown="emit('resizeStart', $event)" @pointermove="emit('resize', $event)" @pointerup="emit('resizeFinish')" @pointercancel="emit('resizeFinish')" @keydown="emit('resizeKeydown', $event)"></button>
  </aside>
</template>

<style scoped>
.desktop-sidebar { position: relative; grid-column: 1; grid-row: 1 / 3; z-index: 2; display: flex; flex-direction: column; min-width: 0; padding: calc(var(--desktop-topbar-height) + 2px) 14px 18px; background: transparent; }
.desktop-sidebar nav { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; scrollbar-width: none; }
.desktop-sidebar nav::-webkit-scrollbar { display: none; }
.nav-group { display: grid; gap: 3px; padding: 0 0 8px; border-bottom: 1px solid color-mix(in srgb, var(--content-divider) 70%, transparent); }
.nav-group-label { padding: 7px 12px 3px; color: var(--text-tertiary, var(--text-secondary)); font-size: 10px; font-weight: 650; letter-spacing: .04em; }
.dev-nav-group { margin-top: auto; border-bottom: 0; padding-bottom: 0; }
.nav-item { display: flex; align-items: center; gap: 13px; width: 100%; min-width: 0; height: 38px; padding: 0 12px; border: 1px solid transparent; border-radius: 10px; color: var(--content-secondary, var(--text-secondary)); background: transparent; font: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: background .16s ease, color .16s ease, border-color .16s ease, box-shadow .16s ease; }
.nav-item :deep(svg) { width: 18px; height: 18px; flex: 0 0 18px; }
.nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-item:hover { color: var(--content-primary, var(--text-primary)); background: color-mix(in srgb, var(--sidebar-item-active) 55%, transparent); }
.nav-item.active { color: var(--sidebar-item-active-fg); background: var(--sidebar-item-active); border-color: var(--sidebar-item-active-border); box-shadow: var(--sidebar-item-active-shadow); font-weight: 650; }
.nav-item-disabled { color: var(--text-secondary); }
.sidebar-footer { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--text-secondary); font-size: 11px; }
.connection-dot { width: 8px; height: 8px; border-radius: 50%; background: #d9a441; }
.connection-dot.connected { background: #54ad72; }
.desktop-sidebar.is-compact { padding-right: 7px; padding-left: 7px; }
.desktop-sidebar.is-compact .nav-label,.desktop-sidebar.is-compact .connection-label,.desktop-sidebar.is-compact .nav-group-label { display: none; }
.desktop-sidebar.is-compact .nav-item { justify-content: center; padding-right: 0; padding-left: 0; }
.desktop-sidebar.is-compact .nav-group { padding-bottom: 6px; }
.desktop-sidebar.is-compact .sidebar-footer { justify-content: center; padding-right: 0; padding-left: 0; }
.sidebar-resize { position: absolute; z-index: 5; top: var(--desktop-topbar-height); right: -5px; bottom: 0; width: 10px; padding: 0; border: 0; background: transparent; cursor: col-resize; touch-action: none; }
.sidebar-resize::after { position: absolute; top: 50%; left: 4px; width: 2px; height: 36px; border-radius: 2px; background: transparent; content: ''; transform: translateY(-50%); transition: background .15s ease; }
.sidebar-resize:hover::after,.sidebar-resize:focus-visible::after { background: var(--primary); }
.sidebar-resize:focus-visible { outline: none; }
@media (max-width: 760px) {
  .desktop-sidebar { padding: calc(var(--desktop-topbar-height) + 2px) 7px 16px; }
  .nav-label,.nav-group-label { display: none; }
  .nav-item { justify-content: center; padding: 0; }
  .sidebar-footer { justify-content: center; padding: 8px 0; font-size: 0; }
  .sidebar-resize { display: none; }
}
</style>
