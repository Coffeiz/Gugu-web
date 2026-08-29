<template>
  <label class="app-checkbox" :class="{ 'is-disabled': disabled }">
    <input type="checkbox" :checked="modelValue" :disabled="disabled" :aria-label="ariaLabel" @change="onChange" />
    <span class="app-checkbox__box" aria-hidden="true">
      <svg v-if="modelValue" viewBox="0 0 10 10" width="10" height="10" fill="none">
        <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
    <span v-if="$slots.default" class="app-checkbox__label"><slot /></span>
  </label>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ modelValue?: boolean; disabled?: boolean; ariaLabel?: string }>(), { modelValue: false, disabled: false })
const emit = defineEmits<{ (event: 'update:modelValue', value: boolean): void }>()
function onChange(event: Event) { emit('update:modelValue', (event.currentTarget as HTMLInputElement).checked) }
</script>

<style scoped>
.app-checkbox { display:inline-flex; align-items:center; gap:7px; min-height:20px; color:var(--content-primary); font:13px var(--font-sans); cursor:pointer; user-select:none; }
.app-checkbox > input { position:absolute; width:1px; height:1px; margin:-1px; opacity:0; pointer-events:none; }
.app-checkbox__box { display:grid; place-items:center; flex:0 0 16px; width:16px; height:16px; box-sizing:border-box; border:1.5px solid var(--action-outline); border-radius:5px; corner-shape:squircle; background:var(--control-bg); color:var(--content-on-accent); transition:background-color var(--motion-hover-control) var(--motion-ease-standard),border-color var(--motion-hover-control) var(--motion-ease-standard); }
.app-checkbox__label { display:inline-flex; align-items:center; line-height:16px; }
.app-checkbox:hover .app-checkbox__box { border-color:var(--action-primary); }
.app-checkbox > input:checked + .app-checkbox__box { border-color:transparent; background:var(--action-primary-bg); }
.app-checkbox > input:focus-visible + .app-checkbox__box { outline:2px solid var(--action-primary); outline-offset:2px; }
.app-checkbox.is-disabled { opacity:.55; cursor:default; }
</style>
