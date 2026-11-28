<template>
  <article class="skill-card" :class="{ off: !props.skill.enabled }">
    <div class="sc-top">
      <span class="sc-name" :title="props.skill.name">{{ props.skill.name }}</span>
      <ToggleSwitch size="sm" :model-value="props.skill.enabled" :aria-label="props.skill.enabled ? t('skills.disable') : t('skills.enable')" @update:model-value="$emit('toggle', props.skill)" />
    </div>
    <div v-if="props.skill.related_tools.length" class="sc-tools">
      {{ t('skills.relatedTools', { count: props.skill.related_tools.length }) }}
    </div>
    <p v-if="props.skill.description_short" class="sc-desc">{{ props.skill.description_short }}</p>
    <div class="sc-foot app-card-actions app-card-actions--compact">
      <span class="sc-acts">
        <button class="card-link-btn" @click="$emit('edit', props.skill)">{{ t('skills.edit') }}</button>
        <button class="card-link-btn danger" @click="$emit('remove', props.skill)">{{ t('skills.delete') }}</button>
      </span>
    </div>
  </article>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import type { UserSkillItem } from '@/services/api'

const props = defineProps<{ skill: UserSkillItem }>()

defineEmits<{
  (event: 'toggle' | 'edit' | 'remove', skill: UserSkillItem): void
}>()

const { t } = useI18n()
</script>

<style scoped>
/* 卡片外观与 Schedules/components/ScheduleCard.vue 同一口径（底色与文件卡共用令牌），差异只在内容布局：技能卡是
   双列瀑布里的一项，因此不设 height:100%，由 break-inside:avoid 保证不被拆列。 */
.skill-card {
  position: relative;
  background: var(--file-card-bg); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--card-shadow);
  --card-actions-inset: var(--space-md); padding: var(--card-actions-inset) var(--card-actions-inset) 0; display: flex; flex-direction: column; gap: var(--space-sm);
  box-sizing: border-box; overflow: hidden; break-inside: avoid;
  transition: var(--card-motion), box-shadow var(--motion-hover-card) ease, opacity var(--hover-motion-control);
}
.skill-card:hover { box-shadow: var(--card-shadow-hover); }
.skill-card.off { opacity: 0.5; }
.sc-top { display: flex; align-items: center; gap: var(--space-sm); min-width: 0; }
.sc-name { min-width: 0; flex: 1; font-size: 13px; line-height: 19px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-tools { font-size: 12px; color: var(--text-secondary); }
.sc-desc { margin: 0; padding: var(--space-sm) var(--space-sm); border-radius: 8px; background: var(--surface-soft); font-size: 12px; line-height: 1.45; color: var(--text-secondary); overflow-wrap: anywhere; }
.sc-foot { display: flex; align-items: center; justify-content: flex-end; margin-top: auto; }
.sc-acts { display: flex; gap: var(--space-sm); justify-content: flex-end; }
</style>
