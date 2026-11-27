<script setup lang="ts">
import { useMailInboxStatus } from '@/views/Mail/useMailInboxStatus'
import Brand from '@/components/common/layout/Brand.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useProjectStore } from '@/stores/projects'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { unreadTotal } = useMailInboxStatus()
const projectStore = useProjectStore()

defineProps<{ activeSection: string; compact: boolean; width: number; minWidth: number; maxWidth: number }>()
const emit = defineEmits<{
  navigate: [section: string]
  openSettings: []
  resizeStart: [event: PointerEvent]
  resize: [event: PointerEvent]
  resizeFinish: []
  resizeKeydown: [event: KeyboardEvent]
}>()
</script>

<template>
  <aside class="desktop-sidebar" :class="{ 'is-compact': compact }" :aria-label="t('navigation.main')">
    <div v-if="!compact" class="sidebar-brand">
      <Brand />
    </div>
    <nav>
      <div class="nav-group">
        <span class="nav-group-label">{{ t('navigation.workspace') }}</span>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'projects' }"
          :aria-label="`${t('navigation.projects')} · ${t('projects.inProgress')} ${projectStore.activeCount}`"
          @click="emit('navigate', 'projects')">
          <Icon name="navigation.projects" size="sm" />
          <span class="nav-label">{{ t('navigation.projects') }}</span>
          <span class="nav-count" aria-hidden="true">{{ projectStore.activeCount }}</span>
        </button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'calendar' }" :aria-label="t('navigation.calendar')" @click="emit('navigate', 'calendar')"><Icon name="navigation.calendar" size="sm" /><span class="nav-label">{{ t('navigation.calendar') }}</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'notes' }" :aria-label="t('navigation.notes')" @click="emit('navigate', 'notes')"><Icon name="canvas.note" size="sm" /><span class="nav-label">{{ t('navigation.notes') }}</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'canvases' }" :aria-label="t('navigation.canvases')" @click="emit('navigate', 'canvases')"><Icon name="canvas.graph" size="sm" /><span class="nav-label">{{ t('navigation.canvases') }}</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'schedules' }" :aria-label="t('navigation.schedules')" @click="emit('navigate', 'schedules')"><Icon name="admin.alarm" size="sm" /><span class="nav-label">{{ t('navigation.schedules') }}</span></button>
      </div>
      <div class="nav-group">
        <span class="nav-group-label">{{ t('navigation.resources') }}</span>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'files' }" :aria-label="t('navigation.files')" @click="emit('navigate', 'files')"><Icon name="file.folder" size="sm" /><span class="nav-label">{{ t('navigation.files') }}</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'skills' }" :aria-label="t('navigation.skills')" @click="emit('navigate', 'skills')"><Icon name="resource.skill" size="sm" /><span class="nav-label">{{ t('navigation.skills') }}</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'mcp' }" :aria-label="t('navigation.mcp')" @click="emit('navigate', 'mcp')"><Icon name="resource.mcp" size="sm" /><span class="nav-label">{{ t('navigation.mcp') }}</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'terminals' }" :aria-label="t('navigation.terminals')" @click="emit('navigate', 'terminals')"><Icon name="admin.terminal" size="sm" /><span class="nav-label">{{ t('navigation.terminals') }}</span></button>
      </div>
      <div class="nav-group">
        <span class="nav-group-label">{{ t('navigation.collaboration') }}</span>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'mail' }" :aria-label="unreadTotal ? `${t('navigation.mail')} (${unreadTotal})` : t('navigation.mail')" @click="emit('navigate', 'mail')"><Icon name="admin.mail" size="sm" /><span class="nav-label">{{ t('navigation.mail') }}</span><span v-if="unreadTotal" class="nav-count" aria-hidden="true">{{ unreadTotal }}</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'contacts' }"
          :aria-label="t('navigation.customers')" @click="emit('navigate', 'contacts')">
          <Icon name="communication.customer" size="sm" /><span class="nav-label">{{ t('navigation.customers') }}</span>
        </button>
        <div class="nav-item soon-item" :aria-label="`${t('navigation.team')} ${t('common.states.comingSoon')}`"><Icon name="communication.team" size="sm" /><span class="nav-label">{{ t('navigation.team') }}</span><span class="soon-badge">{{ t('common.states.comingSoon') }}</span></div>
      </div>
    </nav>
    <button type="button" class="sidebar-footer" :aria-label="t('navigation.personalSettings')" :title="t('navigation.personalSettings')" @click="emit('openSettings')">
      <span class="settings-avatar" aria-hidden="true"><Icon name="user.default" size="sm" tone="inherit" /></span>
      <span class="settings-label">{{ t('navigation.localUser') }}</span>
    </button>
    <button class="sidebar-resize" type="button" role="separator" :aria-label="t('navigation.resizeSidebar')" aria-orientation="vertical" :title="t('navigation.resizeSidebarHint')" :aria-valuemin="minWidth" :aria-valuemax="maxWidth" :aria-valuenow="Math.round(width)" :aria-valuetext="compact ? t('navigation.compactSidebar') : t('navigation.sidebarWidth', { width: Math.round(width) })" @pointerdown="emit('resizeStart', $event)" @pointermove="emit('resize', $event)" @pointerup="emit('resizeFinish')" @pointercancel="emit('resizeFinish')" @keydown="emit('resizeKeydown', $event)"></button>
  </aside>
</template>

<style scoped>
.desktop-sidebar {
  --sidebar-bottom-inset: calc(var(--desktop-workspace-edge) + var(--desktop-workspace-inset) + 1px);
  --sidebar-avatar-size: 32px;
  --sidebar-footer-inset: 8px;
  --sidebar-footer-overlap: calc(var(--sidebar-avatar-size) / 2 + var(--sidebar-footer-inset) + 1px);
  position: relative; grid-column: 1; grid-row: 1 / 3; z-index: 2; display: flex; flex-direction: column; min-width: 0; padding: calc(var(--desktop-topbar-height) + 2px) 14px var(--sidebar-bottom-inset); background: transparent; }
.sidebar-brand {
  flex: none;
  margin-bottom: var(--space-xs);
  pointer-events: none;
}
.sidebar-brand :deep(.brand) { margin-bottom: 0; }
.desktop-sidebar nav {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  margin-bottom: calc(-1 * var(--sidebar-footer-overlap));
  padding-bottom: var(--sidebar-footer-overlap);
  scroll-padding-bottom: var(--sidebar-footer-overlap);
  overflow-y: auto;
  scrollbar-width: none;
}
.desktop-sidebar nav::-webkit-scrollbar { display: none; }
.nav-group { position: relative; display: grid; gap: 3px; padding: 0 0 9px; }
.nav-group::after { content: ""; position: absolute; inset: auto 4px 0; height: 1px; background: var(--divider-line); mask-image: var(--sidebar-divider-mask); pointer-events: none; }
.nav-group-label { padding: 7px 12px 3px; color: var(--text-tertiary, var(--text-secondary)); font-size: 10px; font-weight: 650; letter-spacing: .04em; }
.nav-item { display: flex; align-items: center; gap: 13px; width: 100%; min-width: 0; height: 38px; padding: 0 12px; border: 1px solid transparent; border-radius: 10px; color: var(--content-secondary, var(--text-secondary)); background: transparent; font: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: background .16s ease, color .16s ease, border-color .16s ease, box-shadow .16s ease; }
.nav-item :deep(svg) { width: 18px; height: 18px; flex: 0 0 18px; }
.nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-item:hover:not(.active) { color: var(--content-primary, var(--text-primary)); background: var(--sidebar-item-hover); }
.nav-item.active { color: var(--sidebar-item-active-fg); background: var(--sidebar-item-active); border-color: var(--sidebar-item-active-border); box-shadow: var(--sidebar-item-selected-shadow); font-weight: 650; }
.nav-item.soon-item {
  gap: 5px;
  height: auto;
  min-height: 38px;
  padding-block: 4px;
  padding-inline-end: 2px;
  color: var(--content-disabled);
  cursor: default;
  pointer-events: none;
}
.soon-item .nav-label { white-space: normal; overflow-wrap: anywhere; }
.nav-count {
  margin-inline-start: auto;
  flex: none;
  min-inline-size: 18px;
  padding: 1px var(--space-xs);
  border-radius: var(--radius-pill);
  background: var(--selection-bg);
  color: var(--selection-fg);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  text-align: center;
}
.soon-badge { margin-inline-start: auto; flex: 0 1 auto; min-inline-size: min-content; padding: 2px 4px; text-align: center; border: 1px solid var(--border-hairline); border-radius: var(--radius-pill); background: var(--surface-soft); color: var(--content-tertiary); font-size: 9px; font-weight: 600; letter-spacing: .04em; }
.sidebar-footer { position: relative; flex: none; display: flex; align-items: center; gap: 8px; padding: var(--sidebar-footer-inset); border: 1px solid var(--sidebar-user-border); border-radius: var(--radius-sm); background: var(--surface-card-solid); color: var(--content-primary); box-shadow: var(--sidebar-item-active-shadow); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.settings-avatar { display: grid; place-items: center; width: var(--sidebar-avatar-size); height: var(--sidebar-avatar-size); flex: none; border-radius: 50%; background: var(--avatar-fallback-bg); color: var(--content-on-accent); }
.settings-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.desktop-sidebar.is-compact { --sidebar-footer-overlap: calc(var(--sidebar-avatar-size) / 2); padding-right: 7px; padding-left: 7px; }
.desktop-sidebar.is-compact .nav-label,.desktop-sidebar.is-compact .nav-group-label,.desktop-sidebar.is-compact .soon-badge,.desktop-sidebar.is-compact .nav-count { display: none; }
.desktop-sidebar.is-compact .nav-item { justify-content: center; padding-right: 0; padding-left: 0; }
.desktop-sidebar.is-compact .nav-group { padding-bottom: 7px; }
.desktop-sidebar.is-compact .settings-label { display: none; }
.desktop-sidebar.is-compact .sidebar-footer { align-self: center; justify-content: center; inline-size: var(--sidebar-avatar-size); block-size: var(--sidebar-avatar-size); padding: 0; border: 0; border-radius: 50%; background: transparent; box-shadow: none; }
.sidebar-resize { position: absolute; z-index: 5; top: var(--desktop-topbar-height); right: -5px; bottom: 0; width: 10px; padding: 0; border: 0; background: transparent; cursor: col-resize; touch-action: none; }
.sidebar-resize::after { position: absolute; top: 50%; left: 4px; width: 2px; height: 36px; border-radius: 2px; background: transparent; content: ''; transform: translateY(-50%); transition: background .15s ease; }
.sidebar-resize:hover::after,.sidebar-resize:focus-visible::after { background: var(--primary); }
.sidebar-resize:focus-visible { outline: none; }
@media (max-width: 760px) {
  .desktop-sidebar { --sidebar-footer-overlap: calc(var(--sidebar-avatar-size) / 2); padding: calc(var(--desktop-topbar-height) + 2px) 7px var(--sidebar-bottom-inset); }
  .sidebar-brand,.nav-label,.nav-group-label,.soon-badge,.nav-count { display: none; }
  .nav-item { justify-content: center; padding: 0; }
  .desktop-sidebar .nav-item.soon-item { padding-inline: 0; }
  .settings-label { display: none; }
  .sidebar-footer { align-self: center; justify-content: center; inline-size: var(--sidebar-avatar-size); block-size: var(--sidebar-avatar-size); padding: 0; border: 0; border-radius: 50%; background: transparent; box-shadow: none; }
  .sidebar-resize { display: none; }
}
</style>
