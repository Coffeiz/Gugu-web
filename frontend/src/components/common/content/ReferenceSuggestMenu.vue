<template>
  <Teleport to="body">
    <Transition name="chat-command-pop">
      <div v-if="show" ref="menuRef" class="reference-picker" role="listbox" :style="menuStyle">
      <div v-if="loading" class="reference-pick-empty">{{ t('mindEditorUi.searching') }}</div>
      <div v-else-if="!items.length" class="reference-pick-empty">{{ t('mindEditorUi.noResults', { query }) }}</div>
      <template v-for="group in groups" :key="group.type">
        <div class="reference-pick-group-label">
          <component :is="TYPE_ICON[group.type]" :size="11" weight="bold" />
          {{ t(`mindEditorUi.referenceTypes.${group.type}`) }}
        </div>
        <button v-for="entry in group.entries" :key="`${group.type}-${entry.item.id}`"
                class="reference-pick-item" :class="{ on: entry.index === active }"
                type="button" @mousedown.prevent="$emit('choose', entry.item)">
          <component :is="TYPE_ICON[group.type]" class="reference-pick-icon" :size="14" weight="bold" />
          <span class="reference-pick-label">{{ entry.item.label }}</span>
          <span v-if="entry.item.subtitle" class="reference-pick-sub">{{ entry.item.subtitle }}</span>
        </button>
      </template>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCalendarBlank, PhChatCircle, PhFile, PhStack } from '@phosphor-icons/vue'
import type { MindRefSuggestItem } from '@/services/api'
import { nextZ, registerPopover } from '@/composables/windowz'

defineEmits<{ choose: [item: MindRefSuggestItem] }>()
const { t } = useI18n()
const TYPE_ICON: Record<MindRefSuggestItem['type'], typeof PhStack> = {
  project: PhStack, file: PhFile, event: PhCalendarBlank, conversation: PhChatCircle,
}
const props = defineProps<{
  show: boolean
  anchor?: HTMLElement | null
  position?: { left: number; top: number; bottom: number } | null
  offsetX?: number
  ownerZ?: number
  query: string
  items: MindRefSuggestItem[]
  loading: boolean
  active: number
}>()
const menuRef = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})
let unregisterPopover: (() => void) | null = null

function setPopupZ(z: number) {
  menuStyle.value = { ...menuStyle.value, zIndex: `${z}` }
}

function raisePopup() {
  setPopupZ(Math.max(nextZ(), (props.ownerZ ?? 0) + 1))
}

function reposition() {
  if (!props.show || (!props.anchor && !props.position) || !menuRef.value) {
    return
  }
  const anchorRect = props.anchor?.getBoundingClientRect()
  const menuRect = menuRef.value.getBoundingClientRect()
  const margin = 8
  const gap = 8
  const left = props.position?.left ?? anchorRect?.left
  const top = props.position?.top ?? anchorRect?.top
  const bottom = props.position?.bottom ?? anchorRect?.bottom
  if (left == null || top == null || bottom == null) return
  const preferredLeft = left + (props.offsetX ?? 0)
  const maxLeft = Math.max(margin, window.innerWidth - menuRect.width - margin)
  const clampedLeft = Math.min(Math.max(preferredLeft, margin), maxLeft)
  const below = bottom + gap
  const above = top - menuRect.height - gap
  const menuTop = below + menuRect.height <= window.innerHeight - margin
    ? below
    : Math.max(margin, above)
  const width = props.offsetX && props.offsetX > 8 ? 320 : 290
  menuStyle.value = { ...menuStyle.value, left: `${clampedLeft}px`, top: `${menuTop}px`, width: `${Math.min(width, window.innerWidth - clampedLeft - margin)}px` }
}

function scheduleReposition() {
  void nextTick(reposition)
}

watch(() => [props.show, props.query, props.loading, props.items.length, props.position?.left, props.position?.top, props.position?.bottom, props.anchor, props.offsetX, props.ownerZ] as const, (value, oldValue) => {
  if (value[0] && (!oldValue?.[0] || value[9] !== oldValue[9])) raisePopup()
  scheduleReposition()
})
onMounted(() => {
  unregisterPopover = registerPopover(setPopupZ)
  if (props.show) raisePopup()
  window.addEventListener('resize', scheduleReposition)
  window.addEventListener('scroll', scheduleReposition, true)
})
onUnmounted(() => {
  unregisterPopover?.()
  unregisterPopover = null
  window.removeEventListener('resize', scheduleReposition)
  window.removeEventListener('scroll', scheduleReposition, true)
})
const groups = computed(() => {
  const result: { type: MindRefSuggestItem['type']; entries: { item: MindRefSuggestItem; index: number }[] }[] = []
  const byType = new Map<string, (typeof result)[number]>()
  props.items.forEach((item, index) => {
    let group = byType.get(item.type)
    if (!group) { group = { type: item.type, entries: [] }; byType.set(item.type, group); result.push(group) }
    group.entries.push({ item, index })
  })
  return result
})
</script>

<style>
.reference-picker {
  position: fixed; z-index: 3000; max-height: min(280px, calc(100vh - 16px));
  overflow-y: auto; padding: 5px;
  border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
  background: var(--popup-surface-bg); box-shadow: var(--elevation-popup);
  backdrop-filter: var(--popup-surface-blur); -webkit-backdrop-filter: var(--popup-surface-blur);
}
.chat-command-pop-enter-active,
.chat-command-pop-leave-active {
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard),
              transform var(--motion-hover-control) var(--motion-ease-standard);
  transform-origin: left bottom;
}
.chat-command-pop-enter-from,
.chat-command-pop-leave-to { opacity: 0; transform: translateY(6px) scale(.97); }
.reference-pick-empty { padding: 10px 12px; color: var(--content-secondary); font-size: 12px; }
.reference-pick-group-label { display: flex; align-items: center; gap: 5px; padding: 7px 8px 4px; color: var(--content-tertiary); font-size: 11px; font-weight: 650; }
.reference-pick-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--content-primary); text-align: left; cursor: pointer; }
.reference-pick-item:hover, .reference-pick-item.on { background: var(--popup-item-bg-hover); }
.reference-pick-icon { flex: 0 0 auto; color: var(--action-primary); }
.reference-pick-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.reference-pick-sub { margin-left: auto; overflow: hidden; color: var(--content-tertiary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
</style>
