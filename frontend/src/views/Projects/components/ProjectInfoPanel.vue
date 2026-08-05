<template>
  <div class="project-info-panel" :class="{ 'info-expanded': infoExpanded }">
    <div class="info-block">
      <div class="section">
        <label class="section-label">客户 / 委托方</label>
        <input class="field-input" v-model="client" placeholder="客户名称（选填）" />
      </div>

      <hr class="col-divider" />

      <div class="section">
        <label class="section-label">项目周期</label>
        <DateSpanPicker v-model:startDate="startDate" v-model:endDate="deadline" placeholder="选择开始 — 截止日期" />
      </div>

      <hr class="col-divider" />

      <div class="section">
        <label class="section-label">项目颜色</label>
        <div class="color-grid">
          <button
            v-for="preset in colorPresets"
            :key="preset"
            class="color-chip"
            :class="{ active: color === preset }"
            :style="{ background: preset }"
            @click="$emit('set-color', preset)"
          >
            <PhCheck v-if="color === preset" :size="11" weight="bold" style="color:white" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import DateSpanPicker from '@/components/common/DateSpanPicker.vue'
import { PhCheck } from '@phosphor-icons/vue'

const props = defineProps({
  client: { type: String, required: true },
  startDate: { type: String, required: true },
  deadline: { type: String, required: true },
  color: { type: String, required: true },
  infoExpanded: { type: Boolean, default: false },
  colorPresets: { type: Array as PropType<string[]>, required: true },
})

const emit = defineEmits(['update:client', 'update:startDate', 'update:deadline', 'set-color'])
const client = computedModel('client')
const startDate = computedModel('startDate')
const deadline = computedModel('deadline')

function computedModel(key: 'client' | 'startDate' | 'deadline') {
  return computed({
    get: () => props[key],
    set: value => emit(`update:${key}`, value),
  })
}
</script>

<style scoped>
.project-info-panel { flex-shrink: 0; }
.info-block { display: flex; flex-direction: column; }
.info-expanded .info-block { display: grid; grid-template-columns: 1fr 1fr; gap: 0; align-items: stretch; }
.info-expanded .info-block > .col-divider { display: none; }
.info-expanded .info-block > .section { padding: 11px 16px; position: relative; min-height: 56px; }
.info-expanded .info-block > .section:nth-of-type(3) { grid-column: 1 / -1; }
.info-expanded .info-block > .section:nth-of-type(1), .info-expanded .info-block > .section:nth-of-type(2) { border-bottom: 1px solid rgba(0,0,0,0.07); }
.info-expanded .info-block > .section:nth-of-type(1)::after { content: ''; position: absolute; right: 0; top: 50%; transform: translateY(-50%); width: 1px; height: 28px; background: rgba(0,0,0,0.07); }
.section { display: flex; flex-direction: column; gap: 5px; padding: 8px 0; }
.section-label { font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.07em; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.field-input { width: 100%; padding: 9px 12px; box-sizing: border-box; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; background: rgba(255,255,255,0.5); font-size: 13px; font-family: var(--font-sans); color: var(--text-primary); outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
.field-input:hover, .field-input:focus { border-color: rgba(123,127,178,0.4); background: rgba(255,255,255,0.75); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.1); }
.col-divider { border: none; height: 1px; background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%); margin: 0; }
.color-grid { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
.color-chip { width: 22px; height: 22px; border-radius: 6px; border: 2px solid rgba(255,255,255,0.5); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: border-color 0.15s; padding: 0; outline: none; }
.color-chip:hover { border-color: rgba(255,255,255,0.9); }
.color-chip.active { border-color: #fff; box-shadow: 0 0 0 2px rgba(0,0,0,0.18); }
</style>
