<template>
  <div class="config-field">
    <label class="field-label">{{ label }}</label>
    <input
      class="field-input"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', type === 'number' ? +$event.target.value : $event.target.value)"
    />
  </div>
</template>

<script setup>
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
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.06);
  backdrop-filter: blur(8px);
  font-size: 13px;
  color: rgba(255,255,255,0.85);
  font-family: var(--font-sans);
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  width: 100%;
}
.field-input:focus {
  border-color: rgba(149,144,196,0.55);
  box-shadow: 0 0 0 3px rgba(149,144,196,0.1);
  background: rgba(255,255,255,0.09);
}
.field-input::placeholder { color: rgba(255,255,255,0.2); }
.field-input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; }
</style>
