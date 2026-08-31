<template>
  <div class="interface-type-select">
    <label>{{ label }}</label>
    <div class="interface-type-options">
      <button
        v-for="option in options"
        :key="option.key"
        type="button"
        class="interface-type-option"
        :class="{ active: modelValue === option.key }"
        @click="$emit('update:modelValue', option.key)"
      >{{ option.label }}</button>
    </div>
    <div v-if="hint" class="interface-type-hint">{{ hint }}</div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label: string
  modelValue: string
  options: Array<{ key: string; label: string }>
  hint?: string
}>()

defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<style scoped>
.interface-type-select { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
.interface-type-select > label { color:var(--content-secondary); font-size:11px; font-weight:600; }
.interface-type-options { display:flex; width:100%; gap:1px; }
.interface-type-option { flex:1 1 0; min-width:0; min-height:var(--control-md); box-sizing:border-box; padding:6px 10px; border:1px solid var(--choice-chip-border); border-radius:0; background:var(--choice-chip-bg); color:var(--choice-chip-fg); font:500 12px var(--font-sans); cursor:pointer; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.interface-type-option:first-child { border-radius:9px 0 0 9px; }
.interface-type-option:last-child { border-radius:0 9px 9px 0; }
.interface-type-option:only-child { border-radius:9px; }
.interface-type-option.active { border-color:var(--choice-chip-border-active); background:var(--choice-chip-bg-active); color:var(--choice-chip-fg-active); font-weight:600; }
.interface-type-option:hover { background:var(--choice-chip-bg-hover); border-color:var(--choice-chip-border-hover); color:var(--choice-chip-fg-hover); }
.interface-type-hint { color:var(--content-secondary); font-size:11px; line-height:1.5; }
</style>
