<template>
  <article class="skill-card" :class="{ off: !props.skill.enabled }">
    <div class="sc-top">
      <span class="sc-name" :title="props.skill.name">{{ props.skill.name }}</span>
      <ToggleSwitch size="sm" :model-value="props.skill.enabled" :aria-label="props.skill.enabled ? t('skills.disable') : t('skills.enable')" @update:model-value="$emit('toggle', props.skill)" />
    </div>
    <div class="sc-when">
      <span class="sc-slug">{{ props.skill.slug }}</span>
      <span v-if="props.skill.related_tools.length">{{ t('skills.relatedTools', { count: props.skill.related_tools.length }) }}</span>
    </div>
    <p v-if="props.skill.description_short" class="sc-desc">{{ props.skill.description_short }}</p>
    <div class="sc-foot">
      <span class="sc-updated">{{ t('skills.updatedAt', { date: fmtDate(props.skill.updated_at) }) }}</span>
      <span class="sc-acts">
        <button class="link" @click="$emit('edit', props.skill)">{{ t('skills.edit') }}</button>
        <button class="link danger" @click="$emit('remove', props.skill)">{{ t('skills.delete') }}</button>
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

const { t, locale } = useI18n()

function fmtDate(value: string | null) {
  return value ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(value)) : '—'
}
</script>

<style scoped>
/* 卡片外观与 Schedules/components/ScheduleCard.vue 同一口径（surface/border/shadow/
   hover overlay 全部消费 --card-* 与 --surface-* 令牌），差异只在内容布局：技能卡是
   双列瀑布里的一项，因此不设 height:100%，由 break-inside:avoid 保证不被拆列。 */
.skill-card {
  position: relative;
  background: var(--surface-card); border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--card-shadow);
  padding: 13px 15px; display: flex; flex-direction: column; gap: 7px;
  box-sizing: border-box; overflow: hidden; break-inside: avoid;
  transition: var(--card-motion), box-shadow var(--motion-hover-card) ease, opacity var(--hover-motion-control);
}
.skill-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: var(--card-hover-overlay);
  opacity: 0; transition: var(--card-overlay-motion); pointer-events: none;
}
.skill-card > * { position: relative; z-index: 1; }
.skill-card:hover { box-shadow: var(--card-shadow-hover); }
.skill-card:hover::after { opacity: 1; }
.skill-card.off { opacity: 0.5; }
.sc-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sc-name { min-width: 0; flex: 1; font-size: 13px; line-height: 19px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-when { display: flex; gap: 10px; min-width: 0; font-size: 12px; color: var(--text-secondary); }
.sc-when span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-slug { font-family: var(--font-mono); }
.sc-desc { margin: 0; padding: 6px 9px; border-radius: 8px; background: var(--surface-soft); font-size: 12px; line-height: 1.45; color: var(--text-secondary); overflow-wrap: anywhere; }
.sc-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; }
.sc-updated { font-size: 11px; color: var(--text-secondary); opacity: 0.75; }
.sc-acts { display: flex; gap: 8px; justify-content: flex-end; }
.link { border: 0; border-radius: 6px; background: none; color: var(--text-secondary); cursor: pointer; padding: 2px 3px; font: inherit; font-family: var(--font-sans); font-size: 12px; transition: color 0.15s, background 0.15s; }
.link:hover { color: var(--text-primary); background: var(--action-soft); }
.link.danger:hover { color: var(--status-danger); background: var(--status-danger-bg); }
</style>
