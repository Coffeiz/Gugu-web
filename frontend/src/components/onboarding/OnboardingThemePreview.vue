<template>
  <div class="theme-preview" :class="{ 'is-calendar': mode === 'calendar' }" aria-hidden="true">
    <aside class="preview-sidebar">
      <div class="preview-logo">
        <span class="preview-logo-wordmark" :aria-label="t('onboardingUi.brand')" />
      </div>
      <nav class="preview-nav">
        <span class="preview-nav-label">{{ t('navigation.workspace') }}</span>
        <span class="preview-nav-item" :class="{ active: mode === 'board' }"><Icon name="navigation.projects" size="sm" />{{ t('navigation.projects') }}</span>
        <span class="preview-nav-item" :class="{ active: mode === 'calendar' }"><Icon name="navigation.calendar" size="sm" />{{ t('navigation.calendar') }}</span>
        <span class="preview-nav-item"><Icon name="canvas.note" size="sm" />{{ t('navigation.mind') }}</span>
        <span class="preview-divider" />
        <span class="preview-nav-label">{{ t('navigation.resources') }}</span>
        <span class="preview-nav-item"><Icon name="file.folder" size="sm" />{{ t('navigation.files') }}</span>
      </nav>
      <div class="preview-user">
        <span class="preview-avatar">C</span>
        <span><b>Coffeiz</b><small>Creator</small></span>
      </div>
    </aside>

    <section class="preview-main">
      <header class="preview-topbar">
        <div class="preview-title">
          <b>{{ t('navigation.projects') }}</b>
          <small>Design token preview</small>
        </div>
        <div class="preview-search"><Icon name="action.search" size="xs" /><span>{{ t('common.search') }}</span></div>
        <button type="button" class="preview-secondary">{{ t('common.actions.upload') }}</button>
        <button type="button" class="preview-primary">＋ {{ t('common.actions.createProject') }}</button>
      </header>

      <div v-if="mode === 'board'" class="preview-board">
        <section v-for="column in columns" :key="column.title" class="preview-column">
          <header class="preview-column-head">
            <span class="preview-column-dot" />
            <b>{{ column.title }}</b>
            <small>{{ column.cards.length }}</small>
          </header>
          <article v-for="card in column.cards" :key="card.title" class="preview-card">
            <div class="preview-card-title"><b>{{ card.title }}</b><span>★</span></div>
            <small>{{ card.meta }}</small>
            <div class="preview-progress"><i v-for="n in 4" :key="n" :class="{ done: n <= card.done }" /></div>
          </article>
          <button type="button" class="preview-add">＋ {{ t('common.actions.createProject') }}</button>
        </section>
      </div>
      <section v-else class="preview-calendar" aria-hidden="true">
        <header class="preview-calendar-toolbar">
          <div class="preview-calendar-nav">
            <button type="button"><Icon name="action.back" size="xs" /></button>
            <strong>{{ calendarPeriod }}</strong>
            <button type="button"><Icon name="action.next" size="xs" /></button>
          </div>
          <div class="preview-calendar-actions">
            <span><b>{{ t('calendar.month') }}</b><i>{{ t('calendar.week') }}</i></span>
            <button type="button">{{ t('calendar.today') }}</button>
          </div>
        </header>
        <div class="preview-calendar-layout">
          <div class="preview-calendar-surface">
            <div class="preview-calendar-weekdays">
              <span v-for="(day, index) in weekdayLabels" :key="day" :class="{ weekend: index > 4 }">{{ day }}</span>
            </div>
            <div class="preview-calendar-grid">
              <div v-for="(day, index) in calendarDays" :key="`${day}-${index}`" class="preview-calendar-cell" :class="{ other: index < 5 || index > 31, today: day === 13, weekend: index % 7 > 4 }">
                <span>{{ day }}</span>
                <i v-if="day === 13" class="preview-calendar-chip project">{{ t('onboardingUi.demo.calendarEvent') }}</i>
                <i v-else-if="day === 17" class="preview-calendar-chip">{{ t('onboardingUi.demo.reminder') }}</i>
                <i v-else-if="day === 25" class="preview-calendar-chip project">{{ t('navigation.projects') }}</i>
              </div>
            </div>
          </div>
          <aside class="preview-calendar-sidebar">
            <strong>{{ t('onboardingUi.demo.calendar') }}</strong>
            <small>{{ t('onboardingUi.demo.calendarEvent') }}</small>
            <i>{{ t('onboardingUi.demo.reminder') }}</i>
            <i>{{ t('navigation.projects') }}</i>
          </aside>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'

const { t, locale } = useI18n()
withDefaults(defineProps<{ mode?: 'board' | 'calendar' }>(), { mode: 'board' })
const calendarDate = new Date(2026, 7, 1)
const calendarPeriod = computed(() => new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long' }).format(calendarDate))
const weekdayLabels = computed(() => Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale.value, { weekday: 'narrow' }).format(new Date(2026, 7, 10 + index))))
const calendarDays = [27, 28, 29, 30, 31, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 1, 2, 3, 4, 5, 6]
const columns = [
  { title: 'Backlog', cards: [{ title: 'Portfolio', meta: 'Illustration', done: 2 }, { title: 'Website', meta: 'Personal', done: 1 }] },
  { title: 'Doing', cards: [{ title: 'Gugu', meta: 'Product', done: 3 }, { title: 'Artwork', meta: 'Commission', done: 2 }] },
  { title: 'Done', cards: [{ title: 'Release', meta: 'Archive', done: 4 }] },
]
</script>

<style scoped>
.theme-preview {
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-page);
  box-shadow: var(--elevation-window);
  color: var(--content-primary);
}

.preview-sidebar {
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: var(--space-md) var(--space-sm);
  border-right: 1px solid var(--sidebar-border);
  background: var(--sidebar-bg);
  box-shadow: inset -1px 0 0 var(--sidebar-highlight);
}

.preview-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--space-xs) var(--space-md);
  color: var(--brand-logo-color);
}
.preview-logo-wordmark {
  display: block;
  width: 42px;
  height: 23px;
  background: currentColor;
  -webkit-mask: url('/logo-text.png') center / contain no-repeat;
  mask: url('/logo-text.png') center / contain no-repeat;
}

.preview-nav { display: grid; gap: var(--space-xs); }
.preview-nav-label {
  padding: var(--space-xs) var(--space-sm) 0;
  color: var(--sidebar-label-fg);
  font-size: 9px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: var(--tracking-label);
}
.preview-nav-item {
  height: 28px;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 0 var(--space-sm);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--sidebar-item-fg);
  font-size: 10px;
}
.preview-nav-item.active {
  color: var(--sidebar-item-active-fg);
  background: var(--sidebar-item-active);
  border-color: var(--sidebar-item-active-border);
  box-shadow: var(--sidebar-item-active-shadow);
  font-weight: var(--font-weight-bold);
}
.preview-divider { height: 1px; margin: var(--space-xs); background: var(--divider-line); }

.preview-user {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm);
  border: 1px solid var(--sidebar-user-border);
  border-radius: var(--radius-sm);
  background: var(--sidebar-user-bg);
  box-shadow: var(--sidebar-item-active-shadow);
}
.preview-avatar {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--action-soft);
  color: var(--action-primary);
  font-size: 10px;
  font-weight: var(--font-weight-bold);
}
.preview-user b,.preview-user small { display: block; }
.preview-user b { font-size: 9px; }
.preview-user small { margin-top: 1px; color: var(--content-tertiary); font-size: 8px; }

.preview-main { min-width: 0; display: flex; flex-direction: column; background: var(--surface-page); }
.theme-preview.is-calendar .preview-main { background: var(--surface-page); }
.theme-preview.is-calendar .preview-search { flex: 0 1 260px; max-width: 260px; margin-left: auto; }
.preview-topbar {
  flex: 0 0 48px;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 0 var(--space-md);
  margin: var(--space-sm) var(--space-sm) 0;
  border: 1px solid var(--glass-card-border);
  border-radius: var(--card-radius);
  background: var(--glass-card-background);
  box-shadow: var(--glass-card-shadow);
  backdrop-filter: var(--topbar-blur);
  -webkit-backdrop-filter: var(--topbar-blur);
}
.preview-title { min-width: 112px; }
.preview-title b,.preview-title small { display: block; }
.preview-title b { font-size: 11px; }
.preview-title small { margin-top: 2px; color: var(--content-tertiary); font-size: 8px; }
.preview-search {
  min-width: 0;
  flex: 1;
  height: var(--control-sm);
  display: flex;
  align-items: center;
  padding: 0 var(--space-sm);
  border: 1px solid var(--control-border);
  border-radius: var(--control-radius);
  background: var(--control-bg);
  color: var(--control-fg);
  font-size: 9px;
}
.preview-search span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-primary,.preview-secondary,.preview-add {
  border-radius: var(--control-radius);
  font: var(--font-weight-semibold) 9px/1 var(--font-sans);
}
.preview-primary,.preview-secondary {
  height: var(--control-sm);
  padding: 0 var(--space-sm);
}
.preview-primary { border: 0; color: var(--content-on-accent); background: var(--action-primary-bg); }
.preview-secondary { border: 1px solid var(--action-secondary-border); color: var(--action-secondary-fg); background: var(--action-secondary-bg); }

.preview-board {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: repeat(3,minmax(0,1fr));
  gap: var(--space-sm);
  padding: var(--space-md);
}
.preview-column {
  min-width: 0;
  padding: var(--space-sm);
  border: 1px solid var(--glass-card-border);
  border-radius: var(--card-radius);
  background: var(--glass-card-background);
  box-shadow: var(--glass-card-shadow);
  backdrop-filter: var(--glass-card-blur);
  -webkit-backdrop-filter: var(--glass-card-blur);
}
.preview-column-head {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: 0 var(--space-xs) var(--space-sm);
  font-size: 9px;
}
.preview-column-head small { margin-left: auto; color: var(--content-tertiary); }
.preview-column-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--action-primary); }
.preview-card {
  padding: var(--space-sm);
  margin-bottom: var(--space-sm);
  border: 1px solid var(--project-card-border);
  border-radius: var(--project-card-radius);
  background: linear-gradient(90deg,
    color-mix(in srgb,var(--action-primary) 16%,var(--surface-card-solid)),
    var(--surface-card-solid));
  box-shadow: var(--project-card-shadow);
}
.preview-card-title { display: flex; align-items: center; gap: var(--space-xs); }
.preview-card-title b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
.preview-card-title span { margin-left: auto; color: var(--action-primary); font-size: 8px; }
.preview-card > small { display: block; margin-top: 3px; color: var(--content-tertiary); font-size: 8px; }
.preview-progress { display: grid; grid-template-columns: repeat(4,1fr); gap: 2px; margin-top: var(--space-sm); }
.preview-progress i { height: 3px; border-radius: 999px; background: var(--border-subtle); }
.preview-progress i.done { background: var(--action-primary); }
.preview-add {
  width: 100%;
  height: 26px;
  border: 1px dashed var(--inline-action-border);
  color: var(--inline-action-fg);
  background: var(--inline-action-bg);
}
.preview-calendar { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-sm); overflow: hidden; }
.preview-calendar-toolbar { min-height: 42px; display: flex; align-items: center; justify-content: space-between; padding: 0 var(--space-md); border: 1px solid var(--glass-card-border); border-radius: var(--card-radius); background: var(--glass-card-background); box-shadow: var(--glass-card-shadow); backdrop-filter: var(--glass-card-blur); -webkit-backdrop-filter: var(--glass-card-blur); }
.preview-calendar-nav,.preview-calendar-actions,.preview-calendar-actions span { display: flex; align-items: center; }
.preview-calendar-nav { gap: var(--space-xs); }
.preview-calendar-nav button { width: 21px; height: 21px; display: grid; place-items: center; border: 0; border-radius: var(--radius-sm); color: var(--content-secondary); background: transparent; }
.preview-calendar-nav strong { min-width: 76px; color: var(--content-primary); font-size: 10px; text-align: center; }
.preview-calendar-actions { gap: var(--space-sm); }
.preview-calendar-actions span { gap: 2px; padding: 2px; border-radius: var(--radius-sm); background: var(--action-soft); font-size: 8px; }
.preview-calendar-actions span > * { padding: 3px 6px; border-radius: calc(var(--radius-sm) - 2px); font-style: normal; }
.preview-calendar-actions b { color: var(--action-primary); background: var(--surface-raised); }
.preview-calendar-actions i { color: var(--content-tertiary); }
.preview-calendar-actions > button { padding: 4px 7px; border: 1px solid var(--action-secondary-border); border-radius: var(--radius-sm); color: var(--action-secondary-fg); background: var(--action-secondary-bg); font: var(--font-weight-semibold) 8px/1 var(--font-sans); }
.preview-calendar-layout { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 82px; gap: var(--space-sm); }
.preview-calendar-surface,.preview-calendar-sidebar { min-width: 0; overflow: hidden; border: 1px solid var(--glass-card-border); border-radius: var(--card-radius); background: var(--glass-card-background); box-shadow: var(--glass-card-shadow); backdrop-filter: var(--glass-card-blur); -webkit-backdrop-filter: var(--glass-card-blur); }
.preview-calendar-weekdays,.preview-calendar-grid { display: grid; grid-template-columns: repeat(7,minmax(0,1fr)); }
.preview-calendar-weekdays { flex-shrink: 0; padding: var(--space-sm) 0 0; }
.preview-calendar-weekdays span { padding: 3px 0 6px; border-right: 1px solid var(--calendar-grid-line); color: var(--content-tertiary); font-size: 8px; font-weight: var(--font-weight-semibold); text-align: center; }
.preview-calendar-weekdays span:last-child { border-right: 0; }
.preview-calendar-weekdays span.weekend { color: var(--calendar-weekend-fg); }
.preview-calendar-grid { min-height: 0; flex: 1; grid-template-rows: repeat(6,minmax(0,1fr)); border-top: 1px solid var(--calendar-grid-line); }
.preview-calendar-cell { position: relative; min-height: 0; padding: 4px; border-right: 1px solid var(--calendar-grid-line); border-bottom: 1px solid var(--calendar-grid-line); background: transparent; overflow: hidden; }
.preview-calendar-cell:nth-child(7n) { border-right: 0; }
.preview-calendar-cell > span { width: 16px; height: 16px; display: grid; place-items: center; border-radius: var(--radius-pill); color: var(--content-primary); font-size: 8px; }
.preview-calendar-cell.other { opacity: .34; }
.preview-calendar-cell.weekend { background: var(--calendar-weekend-bg); }
.preview-calendar-cell.today { background: var(--calendar-today-cell-bg); }
.preview-calendar-cell.today > span { color: var(--content-on-accent); background: var(--calendar-today-date-bg); font-weight: var(--font-weight-bold); }
.preview-calendar-chip { display: block; width: 100%; box-sizing: border-box; overflow: hidden; margin-top: 2px; padding: 2px 3px; border: 1px solid var(--action-outline); border-radius: var(--radius-pill); color: var(--action-primary); background: var(--action-soft); font-size: 6px; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
.preview-calendar-chip.project { color: var(--status-success); background: var(--status-success-bg); border-color: color-mix(in srgb,var(--status-success) 35%,transparent); }
.preview-calendar-sidebar { display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-sm); }
.preview-calendar-sidebar strong { font-size: 9px; }
.preview-calendar-sidebar small { color: var(--content-tertiary); font-size: 7px; }
.preview-calendar-sidebar i { display: block; overflow: hidden; padding: 5px; border-radius: var(--radius-sm); color: var(--content-secondary); background: var(--action-soft); font-size: 7px; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
</style>
