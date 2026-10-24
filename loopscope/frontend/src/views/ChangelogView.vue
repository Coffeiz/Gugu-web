<template>
  <div class="changelog">
    <header><span class="eyebrow">LOOPSCOPE</span><h1>{{ t('nav.changelog') }}</h1><p>{{ t('changelog.description') }}</p></header>
    <article v-for="release in releases" :key="release.version" class="release ls-card">
      <div class="release-meta"><strong>{{ release.version }}</strong><span>{{ release.date }}</span></div>
      <h2>{{ t(release.titleKey) }}</h2>
      <ul><li v-for="item in release.itemKeys" :key="item">{{ t(item) }}</li></ul>
    </article>
  </div>
</template>

<script setup lang="ts">
import { useLoopScopeI18n } from '../i18n/index'
const { t } = useLoopScopeI18n()
const releases = [
  {
    version: '0.2.0', date: '2026-08-17', titleKey: 'changelog.contextUsageTitle',
    itemKeys: [
      'changelog.monitorLayout', 'changelog.spanSource', 'changelog.contextSources',
      'changelog.runUsage', 'changelog.sqliteMigration',
    ],
  },
  {
    version: '0.1.0', date: '2026-08-17', titleKey: 'changelog.firstLoopDebugger',
    itemKeys: [
      'changelog.boundaries', 'changelog.sessions', 'changelog.traceInspection', 'changelog.tokenEntry',
    ],
  },
]
</script>

<style scoped>
.changelog { max-width:860px; margin:0 auto; padding:42px 36px 80px; }
.eyebrow { font-size:9px; letter-spacing:.13em; color:var(--content-tertiary); }
header h1 { margin:4px 0; font-size:26px; } header p { margin:0; color:var(--content-secondary); font-size:12px; }
.release { margin-top:18px; padding:18px 20px; }
.release-meta { display:flex; gap:8px; align-items:center; color:var(--content-tertiary); font:10px var(--font-mono); }
.release-meta strong { color:var(--action-primary); }
.release h2 { margin:7px 0 10px; font-size:15px; }
ul { margin:0; padding-left:18px; display:grid; gap:7px; color:var(--content-secondary); font-size:11px; line-height:1.65; }
</style>
