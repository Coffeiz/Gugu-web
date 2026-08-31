<template>
  <div class="theme-preview" aria-hidden="true">
    <aside class="preview-sidebar">
      <div class="preview-logo">
        <span class="preview-logo-mark">咕</span>
        <strong>咕咕</strong>
      </div>
      <nav class="preview-nav">
        <span class="preview-nav-label">{{ t('navigation.workspace') }}</span>
        <span class="preview-nav-item active"><Icon name="navigation.projects" size="sm" />{{ t('navigation.projects') }}</span>
        <span class="preview-nav-item"><Icon name="navigation.calendar" size="sm" />{{ t('navigation.calendar') }}</span>
        <span class="preview-nav-item"><Icon name="navigation.mind" size="sm" />{{ t('navigation.mind') }}</span>
        <span class="preview-divider" />
        <span class="preview-nav-label">{{ t('navigation.resources') }}</span>
        <span class="preview-nav-item"><Icon name="navigation.files" size="sm" />{{ t('navigation.files') }}</span>
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
        <div class="preview-search">⌕ {{ t('common.search') }}</div>
        <button type="button" class="preview-secondary">{{ t('common.actions.upload') }}</button>
        <button type="button" class="preview-primary">＋ {{ t('common.actions.createProject') }}</button>
      </header>

      <div class="preview-board">
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
    </section>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'

const { t } = useI18n()
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
  gap: var(--space-sm);
  padding: 0 var(--space-xs) var(--space-md);
  font-size: var(--font-size-sm);
}
.preview-logo-mark {
  width: 27px;
  height: 27px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--content-on-accent);
  background: var(--action-primary-bg);
  box-shadow: var(--elevation-card);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
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
.preview-topbar {
  flex: 0 0 48px;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 0 var(--space-md);
  border-bottom: 1px solid var(--topbar-border);
  background: var(--topbar-bg);
  box-shadow: var(--topbar-shadow);
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
</style>
