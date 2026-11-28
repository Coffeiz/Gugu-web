<template>
  <PageToolbar class="mind-bar" role="group" :aria-label="t('mind.notes')">
    <SearchInput v-model="store.filterQ" class="mind-filter" :placeholder="t('mind.filter')" clearable />
    <span v-if="devMode" class="mind-dev-badge">DEV</span>
    <ActionButton v-if="devMode" fit variant="secondary" @click="emit('seed')">{{ t('mindThreePane.seed') }}</ActionButton>
    <DatePicker
      :model-value="store.jumpTarget"
      class="mind-cal-picker"
      popup-class="mind-cal-popup"
      :max="todayIso"
      :allowed-dates="allowedDates"
      :show-clear="false"
      :title="t('mind.chooseDate')"
      :trigger-label="t('mind.chooseDate')"
      @update:model-value="jumpToDate"
    />
  </PageToolbar>
</template>

<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import DatePicker from '@/components/common/controls/DatePicker.vue'
import SearchInput from '@/components/common/controls/SearchInput.vue'
import PageToolbar from '@/components/common/layout/PageToolbar.vue'
import { useMindStore } from '@/stores/mind'
import { localDayKey } from '@/utils/dateAttribution'

defineProps({ devMode: { type: Boolean, default: false } })
const emit = defineEmits<{ seed: [] }>()

const store = useMindStore()
const { t } = useI18n()
const todayIso = computed(() => localDayKey(new Date()))
const allowedDates = computed(() => store.timeline.map(group => group.date))

function jumpToDate(date: string) {
  if (store.jumpTarget === date) {
    // 重选同一天也要重新定位列表，供用户从别处滚回这一天。
    store.jumpTarget = ''
    void nextTick(() => { store.jumpTarget = date })
    return
  }
  store.jumpTarget = date
}
</script>

<style scoped>
.mind-bar {
  gap: var(--space-sm);
}
.mind-dev-badge { color: var(--content-secondary); font-size: var(--font-size-xs); }
.mind-bar .mind-cal-picker {
  flex: none;
  width: var(--toolbar-compact-control-height);
  margin-inline-start: auto;
}
.mind-cal-picker :deep(.dp-input) {
  width: 100%;
  height: var(--toolbar-compact-control-height);
  padding: 0;
}
.mind-cal-picker :deep(.dp-input span) { display: none; }
.mind-bar .mind-filter {
  width: 224px;
  min-width: 0;
  height: var(--toolbar-compact-control-height);
  min-height: var(--toolbar-compact-control-height);
}
</style>
