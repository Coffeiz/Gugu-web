<template>
  <button
    type="button"
    class="agent-memory-toggle"
    :class="{ on: modelValue }"
    :aria-pressed="modelValue"
    :aria-label="ariaLabel"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="agent-memory-toggle__knob" />
  </button>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean
  ariaLabel: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

function toggle() {
  if (!props.disabled) emit('update:modelValue', !props.modelValue)
}
</script>

<style scoped>
.agent-memory-toggle {
  position: relative;
  display: inline-flex;
  flex: 0 0 42px;
  align-items: center;
  width: 42px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--control-border);
  border-radius: var(--radius-pill);
  background: var(--control-bg);
  box-shadow: none;
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--motion-ease-standard),
    border-color var(--motion-fast) var(--motion-ease-standard),
    box-shadow var(--motion-fast) var(--motion-ease-standard);
}

.agent-memory-toggle:hover {
  border-color: var(--control-border-hover);
  background: var(--control-bg-hover);
}

.agent-memory-toggle.on,
.agent-memory-toggle.on:hover {
  border-color: var(--action-primary);
  background: var(--action-primary);
}

.agent-memory-toggle:focus-visible {
  outline: none;
  box-shadow: var(--control-focus-shadow);
}

.agent-memory-toggle__knob {
  display: block;
  width: 18px;
  height: 18px;
  margin-left: 2px;
  border-radius: 50%;
  background: var(--content-on-accent);
  box-shadow: var(--elevation-control, 0 1px 3px color-mix(in srgb, var(--content-primary) 18%, transparent));
  transition: transform var(--motion-fast) var(--motion-ease-standard);
}

.agent-memory-toggle.on .agent-memory-toggle__knob {
  transform: translateX(18px);
}

.agent-memory-toggle:disabled {
  opacity: .5;
  cursor: default;
}
</style>
