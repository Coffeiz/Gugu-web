<template>
  <PopupMenu :show="!!selection" :position="selection?.position ?? null" placement="top" popup-class="popup-menu">
    <button type="button" class="popup-menu-item" :disabled="busy || tooLong"
      @pointerdown.prevent.stop @click.stop="capture">
      {{ tooLong ? t('selectionUi.tooLong') : t('selectionUi.proposeEdit') }}
    </button>
  </PopupMenu>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'
import { showAppError, errorMessage } from '@/composables/core/useAppToast'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import { maxSelectionLength, selectionDraftEvent, type SelectionDraft } from './selectionDraft'

type Candidate = Omit<SelectionDraft, 'reference'> & {
  position: { x: number; y: number }
  resolve: () => Promise<SelectionDraft['reference']> | SelectionDraft['reference']
}

const props = defineProps<{ read: () => Candidate | null }>()
const { t } = useI18n()
const selection = shallowRef<Candidate | null>(null)
const busy = shallowRef(false)
const tooLong = computed(() => (selection.value?.content.length ?? 0) > maxSelectionLength)
let frame = 0
let disposed = false
let selectingPointer: number | null = null

function update(event?: Event) {
  if (busy.value || selectingPointer !== null || (event instanceof KeyboardEvent && event.key === 'Escape')) return
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => { selection.value = props.read() })
}
function dismiss(event?: KeyboardEvent) {
  if (event && event.key !== 'Escape') return
  cancelAnimationFrame(frame)
  selection.value = null
}
function press(event: PointerEvent) {
  if (event.target instanceof Element && event.target.closest('.popup-menu')) return
  if (event.isPrimary && event.button === 0) selectingPointer = event.pointerId
  dismiss()
}
function release(event: PointerEvent) {
  if (event.pointerId !== selectingPointer) return
  selectingPointer = null
  update()
}
function cancelPointer() {
  selectingPointer = null
  dismiss()
}
async function capture() {
  const selected = selection.value
  if (!selected || tooLong.value || busy.value) return
  const epoch = getAccountBoundaryEpoch()
  busy.value = true
  dismiss()
  try {
    const { content, location, unsaved, rendered, version } = selected
    const detail = { content, location, unsaved, rendered, ...(version === undefined ? {} : { version }), reference: await selected.resolve() } satisfies SelectionDraft
    if (disposed || epoch !== getAccountBoundaryEpoch()) return
    window.dispatchEvent(new CustomEvent(selectionDraftEvent, { detail }))
  } catch (error) {
    showAppError(errorMessage(error))
  } finally {
    busy.value = false
  }
}
onMounted(() => {
  document.addEventListener('selectionchange', update)
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', cancelPointer, true)
  window.addEventListener('blur', cancelPointer)
  document.addEventListener('keyup', update)
  document.addEventListener('pointerdown', press, true)
  document.addEventListener('keydown', dismiss)
  window.addEventListener('scroll', dismiss, true)
})
onUnmounted(() => {
  disposed = true
  dismiss()
  document.removeEventListener('selectionchange', update)
  window.removeEventListener('pointerup', release, true)
  window.removeEventListener('pointercancel', cancelPointer, true)
  window.removeEventListener('blur', cancelPointer)
  document.removeEventListener('keyup', update)
  document.removeEventListener('pointerdown', press, true)
  document.removeEventListener('keydown', dismiss)
  window.removeEventListener('scroll', dismiss, true)
})
</script>
