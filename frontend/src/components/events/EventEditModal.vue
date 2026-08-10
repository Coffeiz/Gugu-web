<!-- 全局的活动编辑弹窗：笔记页、日历页和其他活动引用卡片共用。
     字段/提醒逻辑只有一份，页面只负责通过 eventModal store 打开活动。 -->
<template>
  <Transition name="form-pop">
    <div v-if="show && isFloating" ref="floatingRef" class="eem-floating" :style="floatingStyle">
      <EventFormPanel :event="event" :form="form" :is-past-date="isPastDate" show-delete autofocus
                      @save="onSave" @close="close" @delete="onDelete" @test-reminder="onTestReminder" />
    </div>
  </Transition>
  <BaseModal v-if="show && !isFloating" :show="true" width="300px" background="rgba(255,255,255,0.9)" @close="close">
    <EventFormPanel :event="event" :form="form" :is-past-date="isPastDate" show-delete autofocus
                    @save="onSave" @close="close" @delete="onDelete" @test-reminder="onTestReminder" />
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
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
const floatingStyle = computed(() => {
  const position = eventModalStore.floatingPosition
  return position ? {
    position: 'fixed' as const,
    top: `${position.top}px`,
    left: `${position.left}px`,
    width: `${position.width}px`,
    zIndex: 2100,
  } : {}
})
const floatingRef = ref<HTMLElement | null>(null)

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
  if (id != null) load(id)
  else event.value = null
})

function close() { eventModalStore.closeModal() }

function onFloatingOutsideClick(event: MouseEvent) {
  if (!isFloating.value || !show.value) return
  if (!floatingRef.value?.contains(event.target as Node)) close()
}

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

onMounted(() => document.addEventListener('click', onFloatingOutsideClick, true))
onBeforeUnmount(() => document.removeEventListener('click', onFloatingOutsideClick, true))
</script>

<style scoped>
.eem-floating { position: fixed; box-sizing: border-box; max-height: calc(100vh - 24px); overflow-y: auto; overscroll-behavior: contain; background: rgba(255,255,255,0.72); backdrop-filter: var(--popup-blur); -webkit-backdrop-filter: var(--popup-blur); border: 1px solid rgba(255,255,255,0.75); border-radius: 16px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 32px rgba(60,70,100,0.12); }
.form-pop-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.form-pop-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.form-pop-enter-from, .form-pop-leave-to { opacity: 0; transform: scale(0.95) translateY(-6px); }
</style>
