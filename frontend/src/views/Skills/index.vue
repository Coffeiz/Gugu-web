<template>
  <div class="skills-page">
    <section class="skills-panel glass-card">
      <header class="section-header"><ActionButton fit @click="openCreate"><Icon name="action.add" :size="14" />{{ t('skills.create') }}</ActionButton></header>
      <div v-if="error" class="error-banner">{{ error }} <button @click="load">{{ t('skills.retry') }}</button></div>
      <div v-if="loading" class="empty-state">{{ t('skills.loading') }}</div>
      <div v-else-if="!skills.length" class="empty-state"><Icon name="resource.skill" :size="32" /><strong>{{ t('skills.emptyTitle') }}</strong><span>{{ t('skills.emptyHint') }}</span><ActionButton fit @click="openCreate">{{ t('skills.createFirst') }}</ActionButton></div>
      <div v-else class="skill-list scroll-surface scroll-surface--compact"><article v-for="skill in skills" :key="skill.slug" class="skill-card"><div class="skill-main"><div class="skill-title"><h2>{{ skill.name }}</h2><span class="status" :class="{ off: !skill.enabled }">{{ skill.enabled ? t('skills.enabled') : t('skills.disabled') }}</span></div><p>{{ skill.description_short }}</p><div class="skill-meta"><span>{{ skill.slug }}</span><span v-if="skill.related_tools.length">{{ t('skills.relatedTools', { count: skill.related_tools.length }) }}</span><span>{{ t('skills.updatedAt', { date: formatDate(skill.updated_at) }) }}</span></div></div><div class="skill-actions"><ToggleSwitch :model-value="skill.enabled" :aria-label="skill.enabled ? t('skills.disable') : t('skills.enable')" @update:model-value="toggleSkill(skill)" /><button class="text-btn" @click="openEdit(skill)">{{ t('skills.edit') }}</button><button class="text-btn danger" @click="removeSkill(skill)">{{ t('skills.delete') }}</button></div></article></div>
    </section>
    <SkillForm :key="formKey" :show="formOpen" :skill="editing" :tools="tools" :busy="saving" :external-error="error" @close="formOpen = false" @save="saveForm" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import ActionButton from '@/components/common/ActionButton.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import type { UserSkillItem, UserSkillWrite } from '@/services/api'
import { confirmDialog } from '@/composables/useConfirmDialog'
import { useUserSkills } from './composables/useUserSkills'
import SkillForm from './components/SkillForm.vue'

const { skills, tools, loading, saving, error, load, save, toggle, remove } = useUserSkills()
const { t, locale } = useI18n()
const formOpen = ref(false)
const formKey = ref(0)
const editing = ref<UserSkillItem | null>(null)
onMounted(load)
function openCreate() { editing.value = null; formKey.value++; formOpen.value = true }
function openEdit(skill: UserSkillItem) { editing.value = skill; formKey.value++; formOpen.value = true }
async function saveForm(data: UserSkillWrite) { await save(data, editing.value?.slug); formOpen.value = false }
async function toggleSkill(skill: UserSkillItem) { try { await toggle(skill) } catch { /* 错误已由 composable 写入页面状态 */ } }
async function removeSkill(skill: UserSkillItem) {
  if (await confirmDialog({ title: t('skills.deleteTitle'), message: t('skills.deleteMessage', { name: skill.name }), tone: 'danger', confirmText: t('skills.deleteConfirm') })) {
    try { await remove(skill) } catch { /* 错误已由 composable 写入页面状态 */ }
  }
}
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(value)) : '—' }
</script>

<style scoped>
.skills-page { height:100%; font-family:var(--font-sans); }.skills-panel { --glass-card-background:var(--column-bg); --glass-card-background-hover:var(--column-bg); height:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:22px 24px; }.section-header { display:flex; align-items:center; justify-content:flex-start; gap:20px; margin-bottom:16px; flex-shrink:0; }.skill-list { flex:1; min-height:0; overflow-y:auto; column-count:2; column-gap:10px; margin:0 -8px; padding:10px 8px 16px; }.skill-card { display:flex; align-items:center; gap:14px; padding:16px; margin:0 0 10px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); background:var(--surface-card-solid); break-inside:avoid; }.skill-main { flex:1; min-width:0; }.skill-title { display:flex; align-items:center; gap:8px; }.skill-title h2 { margin:0; color:var(--content-primary); font-size:14px; }.skill-main p { margin:5px 0; color:var(--content-secondary); font-size:12px; }.status { color:var(--success-fg); font-size:10px; }.status.off { color:var(--content-tertiary); }.skill-meta { display:flex; gap:12px; color:var(--content-tertiary); font-size:11px; }.skill-actions { display:flex; align-items:center; gap:10px; }.switch { width:34px; height:20px; padding:2px; border:0; border-radius:12px; background:var(--control-bg); cursor:pointer; }.switch i { display:block; width:16px; height:16px; border-radius:50%; background:var(--content-tertiary); transition:transform .15s; }.switch.on { background:var(--action-primary-bg); }.switch.on i { background:var(--content-on-accent); transform:translateX(14px); }.text-btn { border:0; background:transparent; color:var(--content-secondary); cursor:pointer; font:inherit; font-size:12px; }.text-btn:hover { color:var(--content-primary); }.text-btn.danger { color:var(--danger-fg); }.empty-state { min-height:300px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--content-secondary); }.empty-state strong { color:var(--content-primary); }.empty-state span { font-size:12px; }.error-banner { padding:10px 12px; border-radius:var(--radius-sm); color:var(--danger-fg); background:var(--danger-bg); font-size:12px; margin-bottom:12px; }.error-banner button { margin-left:10px; border:0; background:transparent; color:inherit; cursor:pointer; }
@media (max-width:720px) { .skill-list { column-count:1; } }
</style>
