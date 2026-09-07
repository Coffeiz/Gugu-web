<template>
  <button type="button" class="toggle-switch" :class="{ on: modelValue, 'toggle-switch--sm': size === 'sm' }" :disabled="disabled" :aria-pressed="modelValue" :aria-label="ariaLabel" @click="emit('update:modelValue', !modelValue)">
    <span class="toggle-knob" aria-hidden="true" />
  </button>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ modelValue: boolean; ariaLabel?: string; size?: 'default' | 'sm'; disabled?: boolean }>(), { size: 'default', disabled: false })
const emit = defineEmits<{ (event: 'update:modelValue', value: boolean): void }>()
</script>
<style scoped>
.toggle-switch { position:relative; display:inline-flex; align-items:center; flex:0 0 38px; width:38px; height:22px; padding:0; box-sizing:border-box; border:1px solid transparent; border-radius:var(--radius-pill); background-color:var(--switch-track-bg) !important; background-image:none !important; box-shadow:none; cursor:pointer; transition:background-color var(--motion-hover-control) var(--motion-ease-standard); }
.toggle-switch--sm { flex-basis:32px; width:32px; height:19px; }
.toggle-switch.on { background-color:var(--switch-track-bg-active) !important; background-image:none !important; box-shadow:none; }
.toggle-knob { position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:var(--switch-thumb-bg); box-shadow:var(--elevation-control,0 1px 3px color-mix(in srgb,var(--content-primary) 18%,transparent)); transition:transform var(--motion-hover-control) var(--motion-ease-standard); }
.toggle-switch--sm .toggle-knob { width:13px; height:13px; }
.toggle-switch.on .toggle-knob { transform:translateX(16px); }
.toggle-switch--sm.on .toggle-knob { transform:translateX(13px); }
.toggle-switch:active:not(:disabled) { transform:none; opacity:1; }
.toggle-switch:focus-visible { outline:2px solid var(--action-outline); outline-offset:2px; }
.toggle-switch:disabled { opacity:.5; cursor:default; }
</style>
