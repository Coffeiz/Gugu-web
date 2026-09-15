<template>
  <div class="iv-toolbar" role="toolbar" :aria-label="ariaLabel" @mousedown.stop @dblclick.stop>
    <template v-if="modeOptions.length">
      <button
        v-for="mode in modeOptions"
        :key="mode.value"
        class="iv-tb-btn iv-tb-mode"
        :class="{ active: mode.active }"
        type="button"
        :aria-pressed="mode.active"
        @click="$emit('mode', mode.value)"
      >
        <Icon v-if="mode.icon" :name="mode.icon" :size="12" />
        <span v-else>{{ mode.label }}</span>
      </button>
      <span class="iv-toolbar-separator" aria-hidden="true"></span>
    </template>
    <template v-if="pageCount > 0">
      <button class="iv-tb-btn" type="button" :title="previousPageLabel" :disabled="page <= 0" @click="$emit('previous-page')">
        <Icon name="action.chevron-back" :size="12" />
      </button>
      <span v-if="!isPageEditing" class="iv-tb-pct iv-page-label" :title="pageJumpLabel" @click.stop="startPageEdit">
        {{ page + 1 }} / {{ pageCount }}
      </span>
      <input
        v-else
        ref="pageInputRef"
        v-model="pageInput"
        class="iv-tb-page-input"
        type="number"
        min="1"
        :max="pageCount"
        :aria-label="pageJumpLabel"
        @keydown.enter="submitPageEdit"
        @keydown.esc="cancelPageEdit"
        @blur="submitPageEdit"
      />
      <button class="iv-tb-btn" type="button" :title="nextPageLabel" :disabled="page >= pageCount - 1" @click="$emit('next-page')">
        <Icon name="action.chevron-next" :size="12" />
      </button>
      <span class="iv-toolbar-separator" aria-hidden="true"></span>
    </template>
    <button class="iv-tb-btn" type="button" :title="zoomOutLabel" @click="$emit('zoom-out')">
      <Icon name="action.subtract" :size="12" />
    </button>
    <span class="iv-tb-pct" :title="resetZoomLabel" @click="$emit('reset-zoom')">{{ Math.round(zoomPercent) }}%</span>
    <button class="iv-tb-btn" type="button" :title="zoomInLabel" @click="$emit('zoom-in')">
      <Icon name="action.add" :size="12" />
    </button>
    <template v-if="showFit">
      <span class="iv-toolbar-separator" aria-hidden="true"></span>
      <button class="iv-tb-btn" :class="{ active: fitActive }" type="button" :title="fitLabel" @click="$emit('fit')">
        <Icon :name="fitIcon" :size="12" />
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import { nextTick, ref } from 'vue'
import type { PropType } from 'vue'

type ToolbarMode = { value: string; label: string; icon?: string; active?: boolean }

const emit = defineEmits<{
  (e: 'previous-page'): void
  (e: 'next-page'): void
  (e: 'go-to-page', page: number): void
  (e: 'zoom-out'): void
  (e: 'reset-zoom'): void
  (e: 'zoom-in'): void
  (e: 'fit'): void
  (e: 'mode', value: string): void
}>()

const props = defineProps({
  ariaLabel: { type: String, required: true },
  zoomPercent: { type: Number, required: true },
  page: { type: Number, default: 0 },
  pageCount: { type: Number, default: 0 },
  modeOptions: { type: Array as PropType<ToolbarMode[]>, default: () => [] },
  showFit: { type: Boolean, default: false },
  fitActive: { type: Boolean, default: false },
  previousPageLabel: { type: String, required: true },
  nextPageLabel: { type: String, required: true },
  zoomOutLabel: { type: String, required: true },
  resetZoomLabel: { type: String, required: true },
  zoomInLabel: { type: String, required: true },
  pageJumpLabel: { type: String, default: '' },
  fitLabel: { type: String, default: '' },
  fitIcon: { type: String, default: 'action.expand' },
})

const pageInputRef = ref<HTMLInputElement | null>(null)
const pageInput = ref('')
const isPageEditing = ref(false)

function startPageEdit() {
  if (props.pageCount <= 0) return
  pageInput.value = String(props.page + 1)
  isPageEditing.value = true
  void nextTick(() => {
    pageInputRef.value?.focus()
    pageInputRef.value?.select()
  })
}

function cancelPageEdit() {
  isPageEditing.value = false
}

function submitPageEdit() {
  if (!isPageEditing.value) return
  const requested = Number.parseInt(pageInput.value, 10)
  if (Number.isInteger(requested)) {
    const page = Math.max(1, Math.min(props.pageCount, requested))
    emit('go-to-page', page - 1)
  }
  isPageEditing.value = false
}
</script>

<style scoped>
.iv-toolbar {
  --iv-toolbar-bg: rgba(255, 255, 255, 0.68);
  --iv-toolbar-filter: blur(18px);
  --iv-toolbar-border: rgba(255, 255, 255, 0.82);
  --iv-toolbar-shadow: 0 4px 16px rgba(80, 90, 110, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.95), inset 1px 0 0 rgba(255, 255, 255, 0.55);
  --iv-toolbar-fg: var(--text-secondary);
  --iv-toolbar-hover-bg: rgba(123, 127, 178, 0.12);
  --iv-toolbar-hover-fg: var(--color-primary);
  --iv-toolbar-pct-hover-fg: var(--text-primary);
  --iv-toolbar-separator: color-mix(in srgb, var(--text-primary) 18%, transparent);
  position: absolute;
  z-index: 2;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 1px;
  background: var(--iv-toolbar-bg);
  backdrop-filter: var(--iv-toolbar-filter);
  -webkit-backdrop-filter: var(--iv-toolbar-filter);
  border: 1px solid var(--iv-toolbar-border);
  border-radius: 20px;
  padding: 3px 5px;
  pointer-events: auto;
  box-shadow: var(--iv-toolbar-shadow);
}
.iv-tb-btn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--iv-toolbar-fg);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.iv-tb-btn svg { display: block; }
.iv-tb-mode {
  width: auto;
  min-width: 34px;
  padding: 0 8px;
  border-radius: 50%;
  font-size: 11px;
  white-space: nowrap;
}
.iv-tb-mode:has(svg) { width: 26px; min-width: 26px; padding: 0; }
.iv-tb-btn:hover:not(:disabled) {
  background: var(--iv-toolbar-hover-bg);
  color: var(--iv-toolbar-hover-fg);
}
.iv-tb-btn:disabled { opacity: .35; cursor: default; }
.iv-tb-btn.active { background: var(--iv-toolbar-hover-bg); }
.iv-tb-pct {
  min-width: 38px;
  padding: 0 2px;
  color: var(--iv-toolbar-fg);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  cursor: pointer;
  letter-spacing: .02em;
  transition: color .15s;
}
.iv-tb-pct:hover { color: var(--iv-toolbar-pct-hover-fg); }
.iv-page-label { min-width: 42px; cursor: default; }
.iv-tb-page-input {
  width: 42px;
  height: 26px;
  padding: 0 3px;
  border: 0;
  border-radius: 13px;
  background: var(--iv-toolbar-hover-bg);
  color: var(--iv-toolbar-fg);
  font: inherit;
  font-weight: 600;
  text-align: center;
  outline: none;
}
.iv-tb-page-input::-webkit-inner-spin-button,
.iv-tb-page-input::-webkit-outer-spin-button { margin: 0; }
.iv-toolbar-separator { width: 1px; height: 18px; margin: 0 4px; background: var(--iv-toolbar-separator); }
</style>

<style>
html[data-theme='dark'][data-family] .iv-toolbar {
  --iv-toolbar-bg: color-mix(in srgb, var(--surface-floating) 90%, transparent);
  --iv-toolbar-filter: var(--popup-surface-blur);
  --iv-toolbar-border: var(--border-strong);
  --iv-toolbar-shadow: var(--elevation-popup), inset 0 1px 0 var(--modal-card-highlight);
  --iv-toolbar-fg: var(--content-secondary);
  --iv-toolbar-hover-bg: var(--option-bg-hover);
  --iv-toolbar-hover-fg: var(--action-primary);
  --iv-toolbar-pct-hover-fg: var(--content-primary);
  --iv-toolbar-separator: color-mix(in srgb, var(--content-primary) 22%, transparent);
}
</style>
