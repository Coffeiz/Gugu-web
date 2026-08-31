<template>
  <div class="multimodal-capabilities" :class="`multimodal-capabilities--${variant}`">
    <div v-if="title" class="multimodal-capabilities-title">
      <span>{{ title }}</span>
      <span v-if="hint" class="multimodal-capabilities-hint">{{ hint }}</span>
    </div>
    <div v-for="dim in dims" :key="dim.key" class="multimodal-capability-row">
      <div class="multimodal-capability-label">
        <span>{{ dim.label }}</span>
        <span v-if="dim.hint && variant === 'admin'" class="multimodal-capabilities-hint">{{ dim.hint }}</span>
      </div>
      <button type="button" :class="variant === 'admin' ? 'pca-btn pca-btn--sm' : 'pm-style-chip'" :disabled="probing !== null && probing !== dim.key" @click="$emit('probe', dim.key)">
        {{ probing === dim.key ? probingLabel : probeLabel }}
      </button>
      <ToggleSwitch :model-value="Boolean(model[dim.field || (dim.key === 'image' ? 'vision' : `vision_${dim.key}`)])" :aria-label="`切换${dim.label}`" @update:model-value="model[dim.field || (dim.key === 'image' ? 'vision' : `vision_${dim.key}`)] = $event" />
    </div>
  </div>
</template>

<script setup lang="ts">
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'

type Dimension = { key: string; label: string; hint?: string; field?: string }
withDefaults(defineProps<{
  model: any
  dims: readonly Dimension[]
  title?: string
  hint?: string
  probing?: string | null
  probeLabel: string
  probingLabel: string
  variant?: 'compact' | 'admin'
}>(), { title: '', hint: '', probing: null, variant: 'compact' })
defineEmits<{ (event: 'probe', key: string): void }>()
</script>

<style scoped>
.multimodal-capabilities { display: flex; flex-direction: column; gap: 4px; }
.multimodal-capabilities-title { display: flex; flex-direction: column; gap: 2px; color: var(--text-primary, inherit); font-size: 12px; font-weight: 650; }
.multimodal-capabilities-hint { color: var(--text-secondary, #888); font-size: 11px; font-weight: 400; }
.multimodal-capability-row { display: flex; align-items: center; gap: 8px; min-height: 30px; color: var(--text-primary, inherit); font-size: 12px; }
.multimodal-capability-label { display: flex; flex-direction: column; gap: 2px; min-width: 34px; flex: 1; }
.multimodal-capability-row > button { flex: 0 0 auto; }
.multimodal-capabilities--admin .multimodal-capability-row { min-height: 36px; }
.multimodal-capabilities--admin .pca-btn { display: inline-flex; align-items: center; justify-content: center; min-height: var(--control-md, 30px); padding: 6px 10px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: rgba(255,255,255,.06); color: rgba(255,255,255,.58); font-size: 12px; cursor: pointer; }
.multimodal-capabilities--admin .pca-btn:disabled { opacity: .5; cursor: default; }
</style>
