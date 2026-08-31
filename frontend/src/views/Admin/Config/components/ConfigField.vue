<template>
  <div class="config-field">
    <label class="field-label">{{ label }}</label>
    <input
      class="field-input"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', type === 'number' ? +($event.target as HTMLInputElement).value : ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<script setup lang="ts">
defineProps({
  label:       String,
  modelValue:  [String, Number],
  placeholder: String,
  type:        { type: String, default: 'text' },
})
defineEmits(['update:modelValue'])
</script>

<style scoped>
.config-field { display: flex; flex-direction: column; gap: 6px; }

.field-label {
  font-size: 11px; font-weight: 600;
  color: rgba(255,255,255,0.3);
  text-transform: uppercase; letter-spacing: 0.06em;
}

.field-input {
  padding: 9px 12px;
  border-radius: 9px;
  backdrop-filter: blur(8px);
  font-size: 13px;
  font-family: var(--font-sans);
  outline: none;
  width: 100%;
}
</style>
