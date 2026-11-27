<template>
  <div class="skills-home">
    <ScrollableCardLayout panel-class="skills-panel">
      <template #actions>
        <div class="skills-actions">
          <ActionButton class="page-toolbar__action" fit @click="openCreate"><Icon name="action.add" :size="14" />{{ t('skills.create') }}</ActionButton>
          <div class="skills-tabs" role="tablist" :aria-label="t('clawhub.mySkills')">
            <ActionButton class="page-toolbar__action" fit :variant="tab === 'local' ? 'primary' : 'secondary'" role="tab" :aria-selected="tab === 'local'" @click="tab = 'local'"><Icon name="resource.skill" :size="14" />{{ t('clawhub.mySkills') }}</ActionButton>
            <ActionButton class="page-toolbar__action" fit :variant="tab === 'clawhub' ? 'primary' : 'secondary'" role="tab" :aria-selected="tab === 'clawhub'" @click="tab = 'clawhub'"><Icon name="resource.marketplace" :size="14" />ClawHub</ActionButton>
          </div>
        </div>
      </template>
      <ClawHubSearch v-if="tab === 'clawhub'" :installed-slugs="installedClawHubSlugs" />
      <template v-if="tab === 'local' && error" #notice>
        <div class="error-banner" role="alert">{{ error }} <button @click="load">{{ t('skills.retry') }}</button></div>
      </template>
      <SkeletonGate v-if="tab === 'local' && loading && !loaded && !skills.length">
        <section v-for="group in 2" :key="group" class="skill-group">
          <SkeletonBlock class="skill-group-title" style="--skeleton-width: 76px" />
          <PageSkeleton collection="skills" :count="2" />
        </section>
      </SkeletonGate>
      <template v-if="tab === 'local' && (loaded || !loading) && !error && !skills.length" #empty>
        <FirstUseEmptyState :title="t('skills.emptyTitle')" :description="t('skills.emptyHint')">
          <template #icon><Icon name="resource.skill" :size="24" /></template>
          <ActionButton fit @click="openChatSetup">{{ t('skills.createFirst') }}</ActionButton>
        </FirstUseEmptyState>
      </template>
      <template v-if="tab === 'local' && skills.length">
        <section v-if="userSkills.length || !clawhubSkills.length" class="skill-group" aria-labelledby="user-skills-heading">
          <h2 id="user-skills-heading" class="skill-group-title">{{ t('skills.managedByUser') }}</h2>
          <div v-if="userSkills.length" class="skill-group-grid card-collection--skills">
            <SkillCard v-for="skill in userSkills" :key="skill.id" :skill="skill" @toggle="toggleSkill" @edit="openEdit" @remove="removeSkill" />
          </div>
          <p v-else class="skill-group-empty">{{ t('skills.userManagedEmpty') }}</p>
        </section>
        <section v-if="assistantSkills.length || !clawhubSkills.length" class="skill-group" aria-labelledby="assistant-skills-heading">
          <h2 id="assistant-skills-heading" class="skill-group-title">{{ t('skills.managedByAssistant') }}</h2>
          <div v-if="assistantSkills.length" class="skill-group-grid card-collection--skills">
            <SkillCard v-for="skill in assistantSkills" :key="skill.id" :skill="skill" @toggle="toggleSkill" @edit="openEdit" @remove="removeSkill" />
          </div>
          <p v-else class="skill-group-empty">{{ t('skills.assistantManagedEmpty') }}</p>
        </section>
        <section v-if="clawhubSkills.length" class="skill-group" aria-labelledby="clawhub-skills-heading">
          <h2 id="clawhub-skills-heading" class="skill-group-title">{{ t('skills.installedFromClawHub') }}</h2>
          <div class="skill-group-grid card-collection--skills">
            <SkillCard v-for="skill in clawhubSkills" :key="`clawhub:${skill.id}`" :skill="skill" @toggle="toggleSkill" @edit="openEdit" @remove="removeSkill" />
          </div>
        </section>
      </template>
    </ScrollableCardLayout>
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
import SkeletonGate from '@/components/common/feedback/skeleton/SkeletonGate.vue'
import SkeletonBlock from '@/components/common/feedback/skeleton/SkeletonBlock.vue'
import PageSkeleton from '@/components/common/feedback/skeleton/PageSkeleton.vue'

import { skillAccessKey } from '@/services/resourceAccess'
import { inject, computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FirstUseEmptyState from '@/components/common/layout/FirstUseEmptyState.vue'
import ScrollableCardLayout from '@/components/common/layout/ScrollableCardLayout.vue'
import type { UserSkillItem, UserSkillWrite } from '@/services/api'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { showAppError } from '@/composables/core/useAppToast'
import { useUiStore } from '@/stores/ui'
import { useUserSkills } from '@/composables/skills/useUserSkills'
import ClawHubSearch from './components/ClawHubSearch.vue'
import SkillCard from './components/SkillCard.vue'
import SkillForm from './components/SkillForm.vue'
import { RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'
import { groupSkillsByManager } from './skillGroups'

const {
  skills, tools, toolsLoaded, toolsLoading, toolsError,
  loaded, loading, saving, error, load, loadTools, save, toggle, remove,
} = useUserSkills()
const clawhubSkills = computed(() => skills.value.filter(skill => skill.storage_source === 'clawhub'))
const installedClawHubSlugs = computed(() => new Set(clawhubSkills.value.map(skill => skill.id)))
const ownedSkills = computed(() => skills.value.filter(skill => skill.storage_source === 'user'))
const userSkills = computed(() => groupSkillsByManager(ownedSkills.value).user)
const assistantSkills = computed(() => groupSkillsByManager(ownedSkills.value).assistant)
const { t } = useI18n()
const uiStore = useUiStore()
const route = useRoute()
const router = useRouter()
const tab = ref<'local' | 'clawhub'>('local')
const formOpen = ref(false)
const formKey = ref(0)
const editing = ref<UserSkillItem | null>(null)

async function openRequestedSkill() {
  const skillId = typeof route.query.skill === 'string' ? route.query.skill : ''
  if (!skillId) return
  const target = skills.value.find(skill => skill.id === skillId) ?? skills.value.find(skill => skill.id === skillId.toUpperCase())
  if (!target) {
    if (!error.value) showAppError(t('skills.targetMissing'))
    await router.replace({ query: { ...route.query, skill: undefined } })
    return
  }
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
const configureWithChat = inject(skillAccessKey, null)?.configureWithChat ?? true

function openChatSetup() {
  if (!configureWithChat) openCreate()
  else uiStore.pendingChatPrefill = t('skills.configureWithChat')
}
function openEdit(skill: UserSkillItem) { editing.value = skill; formKey.value++; formOpen.value = true }
async function saveForm(data: UserSkillWrite) { await save(data, editing.value); formOpen.value = false }
async function toggleSkill(skill: UserSkillItem) { try { await toggle(skill) } catch { /* composable 已写入页面错误 */ } }
async function removeSkill(skill: UserSkillItem) {
  if (await confirmDialog({ title: t('skills.deleteTitle'), message: t('clawhub.deleteMessage', { name: skill.name }), tone: 'danger', confirmText: t('skills.deleteConfirm') })) {
    try { await remove(skill) } catch { /* composable 已写入页面错误 */ }
  }
}
</script>

<style scoped>
.skills-actions { display: flex; width: 100%; box-sizing: border-box; align-items: center; justify-content: space-between; gap: var(--space-md); }
.skills-tabs { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-xs); }
.skills-home { min-height:0; height:100%; display:flex; flex-direction:column; }
.skill-group + .skill-group { margin-top:var(--space-xl); padding-top:var(--space-lg); border-top:1px solid var(--content-divider); }
.skill-group-title { margin:0 0 var(--space-md); color:var(--text-primary); font-size:14px; font-weight:600; }
.skill-group-grid :deep(.skill-card) { height:100%; }
.skill-group-empty { margin:0; padding:var(--space-lg); border:1px dashed var(--content-outline); border-radius:var(--radius-sm); color:var(--text-secondary); font-size:12px; text-align:center; }
.error-banner { padding:var(--space-sm) var(--space-md); border-radius:var(--radius-xs); color:var(--danger-fg); background:var(--danger-bg); font-size:12px; margin-bottom:var(--space-md); }
.error-banner button { margin-left:var(--space-sm); border:0; background:transparent; color:inherit; cursor:pointer; }
</style>
