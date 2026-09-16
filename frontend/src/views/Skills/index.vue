<template>
  <div class="skills-page">
    <section class="skills-panel glass-card">
      <header class="skills-header">
        <div class="skills-nav" role="tablist" :aria-label="t('skills.pageNavigation')">
          <RouterLink to="/skills" class="skills-nav-item" :class="{ active: route.name === 'SkillsHome' }">{{ t('skills.userSkills') }}</RouterLink>
          <RouterLink to="/skills/mcp" class="skills-nav-item" :class="{ active: route.name === 'SkillsMcp' }">{{ t('skills.mcp') }}</RouterLink>
        </div>
      </header>
      <router-view />
    </section>
  </div>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const { t } = useI18n()
</script>

<style scoped>
.skills-page { height:100%; font-family:var(--font-sans); }
.skills-panel { --glass-card-background:var(--column-bg); --glass-card-background-hover:var(--column-bg); height:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:22px 24px; }
.skills-header { display:flex; align-items:center; justify-content:flex-start; margin-bottom:16px; flex-shrink:0; }
.skills-nav { display:inline-flex; align-items:center; gap:4px; padding:3px; border:1px solid var(--border-default); border-radius:var(--radius-md); background:var(--surface-soft); }
.skills-nav-item { padding:7px 14px; border-radius:var(--radius-sm); color:var(--content-secondary); font-size:13px; text-decoration:none; transition:color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard); }
.skills-nav-item:hover { color:var(--content-primary); background:var(--surface-raised); }
.skills-nav-item.active { color:var(--content-primary); background:var(--surface-card); box-shadow:var(--elevation-card); font-weight:600; }
</style>
