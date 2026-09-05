<template>
  <label class="app-checkbox" :class="{ 'is-disabled': disabled }">
    <input class="app-checkbox__input" type="checkbox" :checked="modelValue" :disabled="disabled" :aria-label="ariaLabel" @change="onChange" />
    <span class="app-checkbox__box" aria-hidden="true">
      <svg class="app-checkbox__mark" viewBox="0 0 10 10" width="10" height="10" fill="none">
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
.app-checkbox__box { position:relative; isolation:isolate; display:grid; place-items:center; flex:0 0 var(--control-checkbox-size); width:var(--control-checkbox-size); height:var(--control-checkbox-size); box-sizing:border-box; border:var(--control-checkbox-border-width) solid var(--action-outline); border-radius:var(--control-checkbox-radius); corner-shape:squircle; background:var(--control-bg); color:var(--content-on-accent); transition:border-color var(--motion-hover-control) var(--motion-ease-standard); }
.app-checkbox__box::before { content:''; position:absolute; z-index:0; inset:calc(-1 * var(--control-checkbox-fill-inset)); border-radius:var(--control-checkbox-radius); corner-shape:squircle; background:var(--action-primary-bg); opacity:0; pointer-events:none; transition:opacity var(--motion-hover-control) var(--motion-ease-standard); }
.app-checkbox__mark { position:relative; z-index:1; display:block; opacity:0; transform:scale(.4); transform-origin:center; transition:opacity var(--motion-hover-control) var(--motion-ease-standard),transform var(--motion-hover-control) var(--motion-ease-standard); }
.app-checkbox__label { display:inline-flex; align-items:center; line-height:16px; }
.app-checkbox:hover .app-checkbox__box { border-color:var(--action-primary); }
.app-checkbox > input:checked + .app-checkbox__box { border-color:var(--action-primary); }
.app-checkbox > input:checked + .app-checkbox__box::before { opacity:1; }
.app-checkbox > input:checked + .app-checkbox__box .app-checkbox__mark { opacity:1; transform:scale(1); }
.app-checkbox > input:focus-visible + .app-checkbox__box { outline:2px solid var(--action-primary); outline-offset:2px; }
.app-checkbox.is-disabled { opacity:.55; cursor:default; }
</style>
