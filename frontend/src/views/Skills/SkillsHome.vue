<template>
  <div class="skills-home">
    <div v-if="error" class="error-banner">{{ error }} <button @click="load">{{ t('skills.retry') }}</button></div>
    <div v-if="loading" class="empty-state">{{ t('skills.loading') }}</div>
    <div v-else-if="!skills.length" class="empty-state"><Icon name="resource.skill" :size="32" /><strong>{{ t('skills.emptyTitle') }}</strong><span>{{ t('skills.emptyHint') }}</span><ActionButton fit @click="openChatSetup">{{ t('skills.createFirst') }}</ActionButton></div>
    <div v-else class="skill-list scroll-surface scroll-surface--compact"><SkillCard v-for="skill in skills" :key="skill.slug" :skill="skill" @toggle="toggleSkill" @edit="openEdit" @remove="removeSkill" /></div>
    <SkillForm :key="formKey" :show="formOpen" :skill="editing" :tools="tools" :busy="saving" :external-error="error" @close="formOpen = false" @save="saveForm" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import type { UserSkillItem, UserSkillWrite } from '@/services/api'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { useUiStore } from '@/stores/ui'
import { useUserSkills } from '@/composables/skills/useUserSkills'
import SkillCard from './components/SkillCard.vue'
import SkillForm from './components/SkillForm.vue'
import { RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'

const { skills, tools, loading, saving, error, load, save, toggle, remove } = useUserSkills()
const { t } = useI18n()
const props = defineProps<{ createRequest?: number }>()
const uiStore = useUiStore()
const route = useRoute()
const router = useRouter()
const formOpen = ref(false)
const formKey = ref(0)
const editing = ref<UserSkillItem | null>(null)

watch(() => props.createRequest, (request, previous) => {
  if (request && request !== previous) openCreate()
})

async function openRequestedSkill() {
  const slug = typeof route.query.skill === 'string' ? route.query.skill : ''
  if (!slug) return
  const target = skills.value.find(skill => skill.slug === slug)
  if (!target) return
  openEdit(target)
  await router.replace({ query: { ...route.query, skill: undefined } })
}
const onSkillsChanged = () => { void load() }
onMounted(async () => {
  window.addEventListener(RESOURCE_REFRESH_EVENTS.skills, onSkillsChanged)
  await load(); await openRequestedSkill()
})
onBeforeUnmount(() => window.removeEventListener(RESOURCE_REFRESH_EVENTS.skills, onSkillsChanged))
watch(() => route.query.skill, () => { void openRequestedSkill() })
function openCreate() { editing.value = null; formKey.value++; formOpen.value = true }
function openChatSetup() { uiStore.pendingChatPrefill = t('skills.configureWithChat') }
function openEdit(skill: UserSkillItem) { editing.value = skill; formKey.value++; formOpen.value = true }
async function saveForm(data: UserSkillWrite) { await save(data, editing.value?.slug); formOpen.value = false }
async function toggleSkill(skill: UserSkillItem) { try { await toggle(skill) } catch { /* composable 已写入页面错误 */ } }
async function removeSkill(skill: UserSkillItem) {
  if (await confirmDialog({ title: t('skills.deleteTitle'), message: t('skills.deleteMessage', { name: skill.name }), tone: 'danger', confirmText: t('skills.deleteConfirm') })) {
    try { await remove(skill) } catch { /* composable 已写入页面错误 */ }
  }
}
</script>

<style scoped>
.skills-home { min-height:0; height:100%; display:flex; flex-direction:column; }
.skill-list { flex:1; min-height:0; overflow-y:auto; column-count:2; column-gap:12px; margin:0 -8px; padding:10px 8px 16px; }
.skill-list :deep(.skill-card) { margin:0 0 12px; }
.empty-state { min-height:300px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--content-secondary); }
.empty-state strong { color:var(--content-primary); }.empty-state span { font-size:12px; }
.error-banner { padding:10px 12px; border-radius:var(--radius-sm); color:var(--danger-fg); background:var(--danger-bg); font-size:12px; margin-bottom:12px; }
.error-banner button { margin-left:10px; border:0; background:transparent; color:inherit; cursor:pointer; }
@media (max-width:720px) { .skill-list { column-count:1; } }
</style>
