<!-- 全局的活动编辑弹窗：笔记页、日历页和其他活动引用卡片共用。
     字段/提醒逻辑只有一份，页面只负责通过 eventModal store 打开活动。 -->
<template>
  <PopupMenu ref="floatingPopup" :show="show && isFloating" :style="floatingStyle" popup-class="eem-popup"
             @after-leave="onFloatingLeave">
    <EventFormPanel v-if="event" :event="event" :form="form" :is-past-date="isPastDate" show-delete autofocus
                    @save="onSave" @close="close" @delete="onDelete" @test-reminder="onTestReminder" />
  </PopupMenu>
  <BaseModal v-if="!isFloating" :show="show" width="300px" background="var(--modal-card-bg)" @close="close">
    <EventFormPanel v-if="event" :event="event" :form="form" :is-past-date="isPastDate" show-delete autofocus
                    @save="onSave" @close="close" @delete="onDelete" @test-reminder="onTestReminder" />
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'
import { eventsApi } from '@/services/api'
import { useEventModalStore } from '@/stores/eventModal'
import { useLiveStore } from '@/stores/live'
import { useEventEditForm, type EditingEvent } from '@/composables/useEventEditForm'
import { showAppError, showAppNotice } from '@/composables/useAppToast'
import EventFormPanel from './EventFormPanel.vue'

const eventModalStore = useEventModalStore()
const liveStore = useLiveStore()
const form = useEventEditForm()
const event = ref<EditingEvent | null>(null)
// 不在请求刚开始时先挂一个「加载中」空弹窗：活动引用来自思维面板时，先取齐活动和
// 提醒数据，再让 BaseModal 入场，避免用户看到空壳闪一下后才替换成编辑表单。
const show = computed(() => eventModalStore.openEventId != null && event.value != null)
const isFloating = computed(() => eventModalStore.floating && eventModalStore.floatingPosition != null)
// 浮动编辑窗关闭时保留表单内容，直到 PopupMenu 的离场过渡结束，避免宿主高度先塌成扁条。
const floatingLeaving = ref(false)
const floatingTop = ref<number | null>(null)
const floatingStyle = computed(() => {
  const position = eventModalStore.floatingPosition
  return position ? {
    position: 'fixed' as const,
    top: `${floatingTop.value ?? position.top}px`,
    left: `${position.left}px`,
    width: `${position.width}px`,
    zIndex: 2100,
  } : {}
})
const floatingPopup = ref<InstanceType<typeof PopupMenu> | null>(null)
let clampRaf = 0

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isPastDate(d: string | null | undefined) { return !!d && d < todayIso() }

let loadSeq = 0
async function load(id: number) {
  const seq = ++loadSeq
  event.value = null
  try {
    const e = await eventsApi.get(id)
    const loadedEvent: EditingEvent = {
      id: e.id, name: e.title, date: e.date ?? '', time: e.time || '', endTime: e.endTime || '',
      description: e.description || '', allDay: !e.time, version: e.version,
    }
    await form.loadReminders(loadedEvent)
    // 快速连点两张活动卡时，较早请求可能后返回；不能让它覆盖最新一次打开目标。
    if (seq === loadSeq && eventModalStore.openEventId === id) event.value = loadedEvent
  } catch {
    if (seq === loadSeq && eventModalStore.openEventId === id) close()
  }
}

watch(() => eventModalStore.openEventId, (id) => {
  floatingTop.value = null
  if (id != null) {
    floatingLeaving.value = false
    load(id)
  } else {
    // 活动胶囊再次点击会直接调用 store.closeModal，而不是经过本组件的 close()。
    // 此时 store 已同步清掉 floating 标记；通过宿主仍可见来识别这条路径，
    // 保留表单直到离场过渡完成，避免宿主高度塌成 10px。
    const popupElement = floatingPopup.value?.element()
    const popupStillVisible = !!popupElement && getComputedStyle(popupElement).display !== 'none'
    if (event.value && popupStillVisible) floatingLeaving.value = true
    if (!floatingLeaving.value) event.value = null
  }
})

function close() {
  if (isFloating.value && event.value) floatingLeaving.value = true
  eventModalStore.closeModal()
}

function onFloatingLeave() {
  floatingLeaving.value = false
  if (eventModalStore.openEventId == null) event.value = null
}

function onFloatingOutsideClick(event: MouseEvent) {
  if (!isFloating.value || !show.value) return
  const target = event.target as HTMLElement
  // DatePicker/DateSpanPicker 都 Teleport 到 body，它们不是浮动编辑窗的 DOM 子节点，
  // 但属于当前编辑窗的交互范围，不能被 capture 阶段的 outside-click 误关。
  if (target.closest('.dp-popup, .drp-popup')) return
  // 活动胶囊自身会负责“再次点击关闭 / 点击其他活动切换”；捕获阶段不能先把
  // store 清空，否则胶囊 click 处理器会把同一活动重新打开，触发一次假离场再入场。
  if (target.closest('.chip-ev-click, .chip-ev-tag, .event-pill, .calendar-event, .cal-event')) return
  // “更多”活动列表同样是活动触发器：点击同一活动时交给 openEditForm
  // 做 toggle，不能被浮窗的 outside 捕获监听提前关闭后又重新打开。
  if (target.closest('.overflow-popup, .overflow-item')) return
  if (!floatingPopup.value?.contains(target)) close()
}

function clampFloatingIntoView() {
  cancelAnimationFrame(clampRaf)
  clampRaf = requestAnimationFrame(async () => {
    await nextTick()
    if (!isFloating.value || !show.value || !floatingPopup.value) return
    const position = eventModalStore.floatingPosition
    if (!position) return
    const height = floatingPopup.value.element()?.getBoundingClientRect().height || 0
    const safeGap = 12
    const maxTop = Math.max(safeGap, window.innerHeight - height - safeGap)
    const top = Math.min(Math.max(position.top, safeGap), maxTop)
    if (Math.abs((floatingTop.value ?? position.top) - top) > 0.5) floatingTop.value = top
  })
}

watch(
  [show, isFloating, () => form.reminders.value.length, () => form.reminderChannels.value.join('|')],
  clampFloatingIntoView,
  { flush: 'post' },
)

async function onSave() {
  if (!event.value?.name) return
  const eventId = event.value.id as number
  try {
    await form.saveEvent(event.value)
    close()
  } catch (e: any) {
    if (e?.status === 409) {
      showAppError('活动已被其他用户修改，已刷新页面')
      await load(eventId)
      liveStore.bump('calendar')
    }
  }
}
async function onDelete() {
  if (!event.value) return
  await form.deleteEvent(event.value.id)
  close()
}

async function onTestReminder() {
  try {
    const res = await form.testReminderChannels(event.value?.name || '活动提醒')
    showAppNotice(res?.msg || '已发送测试消息')
  } catch {
    showAppError('测试失败，请稍后重试')
  }
}

onMounted(() => {
  document.addEventListener('click', onFloatingOutsideClick, true)
  window.addEventListener('resize', clampFloatingIntoView)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(clampRaf)
  document.removeEventListener('click', onFloatingOutsideClick, true)
  window.removeEventListener('resize', clampFloatingIntoView)
})
</script>

<style scoped>
:global(.popup-menu-host.eem-popup) {
  position: fixed; box-sizing: border-box; max-height: calc(100vh - 24px); overflow-y: auto; overscroll-behavior: contain;
  color: var(--content-primary); border-radius: var(--event-popup-radius);
}
</style>
