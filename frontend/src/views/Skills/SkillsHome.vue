<template>
  <div class="skills-home">
    <div v-if="error" class="error-banner">{{ error }} <button @click="load">{{ t('skills.retry') }}</button></div>
    <div v-if="loading" class="empty-state">{{ t('skills.loading') }}</div>
    <div v-else-if="!skills.length" class="empty-state"><Icon name="resource.skill" :size="32" /><strong>{{ t('skills.emptyTitle') }}</strong><span>{{ t('skills.emptyHint') }}</span><ActionButton fit @click="openChatSetup">{{ t('skills.createFirst') }}</ActionButton></div>
    <div v-else class="skill-list scroll-surface scroll-surface--compact">
      <section class="skill-group" aria-labelledby="user-skills-heading">
        <h2 id="user-skills-heading" class="skill-group-title">{{ t('skills.managedByUser') }}</h2>
        <div v-if="userSkills.length" class="skill-group-grid">
          <SkillCard v-for="skill in userSkills" :key="skill.slug" :skill="skill" @toggle="toggleSkill" @edit="openEdit" @remove="removeSkill" />
        </div>
        <p v-else class="skill-group-empty">{{ t('skills.userManagedEmpty') }}</p>
      </section>
      <section class="skill-group" aria-labelledby="assistant-skills-heading">
        <h2 id="assistant-skills-heading" class="skill-group-title">{{ t('skills.managedByAssistant') }}</h2>
        <div v-if="assistantSkills.length" class="skill-group-grid">
          <SkillCard v-for="skill in assistantSkills" :key="skill.slug" :skill="skill" @toggle="toggleSkill" @edit="openEdit" @remove="removeSkill" />
        </div>
        <p v-else class="skill-group-empty">{{ t('skills.assistantManagedEmpty') }}</p>
      </section>
    </div>
      <SkillForm
        :key="formKey"
        :show="formOpen"
        :skill="editing"
        :tools="tools"
        :tools-loaded="toolsLoaded"
        :tools-loading="toolsLoading"
        :tools-error="toolsError"
        :busy="saving"
        :external-error="error"
        @close="formOpen = false"
        @load-tools="loadTools"
        @save="saveForm"
      />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import { groupSkillsByManager } from './skillGroups'

const {
  skills, tools, toolsLoaded, toolsLoading, toolsError,
  loading, saving, error, load, loadTools, save, toggle, remove,
} = useUserSkills()
const groupedSkills = computed(() => groupSkillsByManager(skills.value))
const userSkills = computed(() => groupedSkills.value.user)
const assistantSkills = computed(() => groupedSkills.value.assistant)
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
.skill-list { flex:1; min-height:0; overflow-y:auto; margin:0 -8px; padding:10px 8px 16px; }
.skill-group + .skill-group { margin-top:20px; padding-top:16px; border-top:1px solid var(--content-divider); }
.skill-group-title { margin:0 0 12px; color:var(--text-primary); font-size:14px; font-weight:600; }
.skill-group-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; }
.skill-group-grid :deep(.skill-card) { height:100%; }
.skill-group-empty { margin:0; padding:14px; border:1px dashed var(--content-outline); border-radius:var(--radius-md); color:var(--text-secondary); font-size:12px; text-align:center; }
.empty-state { min-height:300px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--content-secondary); }
.empty-state strong { color:var(--content-primary); }.empty-state span { font-size:12px; }
.error-banner { padding:10px 12px; border-radius:var(--radius-sm); color:var(--danger-fg); background:var(--danger-bg); font-size:12px; margin-bottom:12px; }
.error-banner button { margin-left:10px; border:0; background:transparent; color:inherit; cursor:pointer; }
@media (max-width:720px) { .skill-group-grid { grid-template-columns:1fr; } }
</style>
