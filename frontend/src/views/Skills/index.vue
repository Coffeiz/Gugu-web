<template>
  <div class="skills-page">
    <section class="skills-panel glass-card">
      <header class="section-header"><ActionButton fit @click="openCreate"><Icon name="action.add" :size="14" />{{ t('skills.create') }}</ActionButton></header>
      <div v-if="error" class="error-banner">{{ error }} <button @click="load">{{ t('skills.retry') }}</button></div>
      <div v-if="loading" class="empty-state">{{ t('skills.loading') }}</div>
      <div v-else-if="!skills.length" class="empty-state"><Icon name="resource.skill" :size="32" /><strong>{{ t('skills.emptyTitle') }}</strong><span>{{ t('skills.emptyHint') }}</span><ActionButton fit @click="openCreate">{{ t('skills.createFirst') }}</ActionButton></div>
      <div v-else class="skill-list scroll-surface scroll-surface--compact"><SkillCard v-for="skill in skills" :key="skill.slug" :skill="skill" @toggle="toggleSkill" @edit="openEdit" @remove="removeSkill" /></div>
    </section>
    <SkillForm :key="formKey" :show="formOpen" :skill="editing" :tools="tools" :busy="saving" :external-error="error" @close="formOpen = false" @save="saveForm" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import type { UserSkillItem, UserSkillWrite } from '@/services/api'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { useUserSkills } from '@/composables/skills/useUserSkills'
import SkillCard from './components/SkillCard.vue'
import SkillForm from './components/SkillForm.vue'

const { skills, tools, loading, saving, error, load, save, toggle, remove } = useUserSkills()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const formOpen = ref(false)
const formKey = ref(0)
const editing = ref<UserSkillItem | null>(null)
// 聊天技能卡片 / 全局搜索跳转是 router.push（?skill=slug）：已在 /skills 时组件
// 不会重新挂载，所以 onMounted 之外还要 watch query 变化。
async function openRequestedSkill() {
  const slug = typeof route.query.skill === 'string' ? route.query.skill : ''
  if (!slug) return
  const target = skills.value.find(skill => skill.slug === slug)
  if (!target) return
  openEdit(target)
  // 用完即清：skill 留在地址栏的话，关掉编辑窗后一刷新又会弹出来（与
  // Schedules/Canvas/Notes 的 object_id 同一契约）。replace 不产生历史记录；
  // 清空触发的 watch 拿到空串直接返回，是安全的空操作。
  await router.replace({ query: { ...route.query, skill: undefined } })
}
onMounted(async () => {
  await load()
  await openRequestedSkill()
})
watch(() => route.query.skill, () => { void openRequestedSkill() })
function openCreate() { editing.value = null; formKey.value++; formOpen.value = true }
function openEdit(skill: UserSkillItem) { editing.value = skill; formKey.value++; formOpen.value = true }
async function saveForm(data: UserSkillWrite) { await save(data, editing.value?.slug); formOpen.value = false }
async function toggleSkill(skill: UserSkillItem) { try { await toggle(skill) } catch { /* 错误已由 composable 写入页面状态 */ } }
async function removeSkill(skill: UserSkillItem) {
  if (await confirmDialog({ title: t('skills.deleteTitle'), message: t('skills.deleteMessage', { name: skill.name }), tone: 'danger', confirmText: t('skills.deleteConfirm') })) {
    try { await remove(skill) } catch { /* 错误已由 composable 写入页面状态 */ }
  }
}
</script>

<style scoped>
.skills-page { height:100%; font-family:var(--font-sans); }.skills-panel { --glass-card-background:var(--column-bg); --glass-card-background-hover:var(--column-bg); height:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:22px 24px; }.section-header { display:flex; align-items:center; justify-content:flex-start; gap:20px; margin-bottom:16px; flex-shrink:0; }
/* 双列瀑布：卡片本体样式在 components/SkillCard.vue；这里只负责列宽节奏与外层滚动。
   卡片的 hover 投影会溢出边框，用左右负 margin 兑现出宿主的内边距。 */
.skill-list { flex:1; min-height:0; overflow-y:auto; column-count:2; column-gap:12px; margin:0 -8px; padding:10px 8px 16px; }
.skill-list :deep(.skill-card) { margin:0 0 12px; }
.empty-state { min-height:300px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--content-secondary); }.empty-state strong { color:var(--content-primary); }.empty-state span { font-size:12px; }.error-banner { padding:10px 12px; border-radius:var(--radius-sm); color:var(--danger-fg); background:var(--danger-bg); font-size:12px; margin-bottom:12px; }.error-banner button { margin-left:10px; border:0; background:transparent; color:inherit; cursor:pointer; }
@media (max-width:720px) { .skill-list { column-count:1; } }
</style>
