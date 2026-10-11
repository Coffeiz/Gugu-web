<template>
  <div class="mind-bar">
    <div class="mind-bar-side"></div>
    <SegmentedControl class="mind-tabs" :active-index="isCanvas ? 1 : 0" style="--pill-radius: 999px">
      <RouterLink to="/mind/notes" class="mind-tab" :class="{ on: isNotes }">
        <PhNotePencil :size="16" weight="bold" />
        {{ t('mind.notes') }}
      </RouterLink>
      <RouterLink to="/mind/canvases" class="mind-tab" :class="{ on: isCanvas }">
        <PhGraph :size="16" weight="bold" />
        {{ t('mind.canvases') }}
      </RouterLink>
    </SegmentedControl>
    <div class="mind-bar-side right">
      <template v-if="isNotes">
        <span v-if="devMode" class="mind-dev-badge">DEV</span>
        <button v-if="devMode" class="mind-seed" @click="$emit('seed')">{{ t('mindThreePane.seed') }}</button>
        <DatePicker
          v-model="store.jumpTarget"
          class="mind-cal-picker"
          popup-class="mind-cal-popup"
          :max="todayIso"
          :allowed-dates="store.timeline.map(group => group.date)"
          :show-clear="false"
          :title="t('mind.chooseDate')"
          @today="retriggerTodayJump"
        />
        <div class="mind-filter">
          <PhMagnifyingGlass :size="13" weight="bold" class="mf-icon" />
          <input v-model="store.filterQ" type="text" :placeholder="t('mind.filter')" :aria-label="t('mind.filter')" />
          <button v-if="store.filterQ" class="mf-clear" :title="t('mind.clear')" @click="store.filterQ = ''">
            <PhX :size="11" weight="bold" />
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { RouterLink } from 'vue-router'
import { PhGraph, PhMagnifyingGlass, PhNotePencil, PhX } from '@phosphor-icons/vue'
import { useMindStore } from '@/stores/mind'
import { localDayKey } from '@/utils/dateAttribution'
import DatePicker from '@/components/common/controls/DatePicker.vue'
import SegmentedControl from '@/components/common/controls/SegmentedControl.vue'
import { useI18n } from 'vue-i18n'

defineProps({ devMode: { type: Boolean, default: false } })
defineEmits<{ (event: 'seed'): void }>()

const route = useRoute()
const store = useMindStore()
const { t } = useI18n()
const isNotes = computed(() => route.path.startsWith('/mind/notes') || route.path.startsWith('/dev/notes-'))
const isCanvas = computed(() => route.path.startsWith('/mind/canvases'))
const todayIso = computed(() => localDayKey(new Date()))

function retriggerTodayJump() {
  store.jumpTarget = ''
  void nextTick(() => { store.jumpTarget = todayIso.value })
}
</script>

<style scoped>
.mind-bar {
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; gap: 12px;
  position: relative; z-index: 40; pointer-events: none;
  flex-shrink: 0; margin: 28px 24px 0;
}
.mind-bar-side { display: flex; align-items: center; }
.mind-bar-side.right { justify-content: flex-end; gap: 10px; pointer-events: auto; }
.mind-dev-badge {
  flex: none; padding: 3px 8px; border-radius: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
  color: var(--color-primary);
  border: 1px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
}
.mind-seed {
  flex: none; height: 30px; padding: 0 12px; border-radius: 999px;
  font-size: 12px; color: var(--color-primary); cursor: pointer; font-family: inherit;
  border: 1px dashed color-mix(in srgb, var(--color-primary) 45%, transparent);
  transition: background 0.15s;
}
.mind-seed:hover { background: color-mix(in srgb, var(--color-primary) 10%, transparent); }
.mind-tabs {
  gap: 2px; padding: 2px;
  border-radius: 999px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  pointer-events: auto;
}
.mind-tab {
  display: inline-flex; align-items: center; gap: 6px;
  height: 36px; box-sizing: border-box; padding: 0 17px; border-radius: 999px;
  font-size: 13.5px; font-weight: 600; color: var(--text-secondary);
  text-decoration: none; cursor: pointer; transition: color 0.15s;
}
.mind-tab:hover { color: var(--color-primary); }
.mind-tab.on { color: var(--text-primary); }
:deep(.mind-cal-picker) { width: auto !important; }
:deep(.mind-cal-picker .dp-input) {
  width: 40px; height: 40px; padding: 0; box-sizing: border-box; justify-content: center;
  border-radius: 999px;
}
:deep(.mind-cal-picker .dp-input span) { display: none; }
.mind-filter {
  display: flex; align-items: center; gap: 6px;
  width: 200px; height: 40px; box-sizing: border-box;
  margin-right: 14px; padding: 0 12px;
  border: 1px solid transparent; border-radius: 999px;
}
.mf-icon { flex-shrink: 0; color: var(--text-secondary); opacity: 0.7; }
.mind-filter input {
  flex: 1; min-width: 0; border: none; outline: none; background: none;
  font-size: 12.5px; color: var(--text-primary); font-family: var(--font-sans);
}
.mind-filter input::placeholder { color: var(--text-secondary); opacity: 0.6; }
.mf-clear {
  flex-shrink: 0; display: inline-flex; padding: 2px;
  border: none; border-radius: 4px; background: none;
  color: var(--text-secondary); cursor: pointer;
}
</style>
