<template>
  <button
    class="app-action-button"
    :class="[`is-${variant}`, { 'is-fit': fit }]"
    :disabled="disabled"
    type="button"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'primary' | 'secondary'; disabled?: boolean; fit?: boolean }>(), {
  variant: 'primary',
  disabled: false,
  fit: false,
})
</script>

<style scoped>
.app-action-button {
  box-sizing: border-box;
  width: 64px;
  min-width: 64px;
  height: 34px;
  min-height: 34px;
  flex: 0 0 64px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font: 500 13px/1 var(--font-sans);
  white-space: nowrap;
  word-break: keep-all;
  writing-mode: horizontal-tb;
  cursor: pointer;
  transition: filter var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard),
    color var(--motion-hover-control) var(--motion-ease-standard),
    box-shadow var(--motion-hover-control) var(--motion-ease-standard),
    opacity var(--motion-hover-control) ease;
}
.app-action-button.is-fit { width: auto; min-width: 0; flex-basis: auto; }
.app-action-button.is-primary {
  border: 0;
  color: var(--content-on-accent);
  background: var(--action-primary-bg);
  box-shadow: none;
}
.app-action-button.is-primary:hover:not(:disabled) { background: var(--action-primary-bg); filter: brightness(1.05); box-shadow: none; opacity: .92; }
.app-action-button.is-secondary {
  border: 1px solid var(--action-secondary-border);
  color: var(--action-secondary-fg);
  background: var(--action-secondary-bg);
  box-shadow: none;
}
.app-action-button.is-secondary:hover:not(:disabled) {
  border-color: var(--action-secondary-border-hover);
  color: var(--action-secondary-fg-hover);
  background: var(--action-secondary-bg);
  filter: brightness(1.04);
  box-shadow: none;
}
.app-action-button:disabled { opacity: .5; cursor: default; }
.app-action-button:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
</style>
