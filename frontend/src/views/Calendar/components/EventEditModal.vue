<!-- 全局的活动编辑弹窗：笔记页点活动引用卡片时弹这个（不依赖日历页是否挂载）。
     跟 Calendar/index.vue 自己那个跟随点击位置的浮层共用 EventEditFields + useEventEditForm，
     字段/提醒逻辑只有一份，这里只是换了个居中弹窗的外壳。 -->
<template>
  <BaseModal :show="show" width="300px" background="rgba(255,255,255,0.9)" @close="close">
    <div class="eem-body" v-if="event">
      <div class="popup-header">
        <span class="popup-title">编辑活动</span>
        <button class="popup-close-btn" @click="close" title="关闭">
          <PhX :size="12" weight="bold" />
        </button>
      </div>
      <EventEditFields :event="event" :form="form" :is-past-date="isPastDate" autofocus
                       @save="onSave" @close="close" @test-reminder="onTestReminder" />
      <div class="popup-actions">
        <button class="popup-save" @click="onSave" :disabled="!event.name">保存</button>
        <button class="popup-delete" @click="onDelete">删除</button>
      </div>
      <div v-if="toastMsg" class="eem-toast">{{ toastMsg }}</div>
    </div>
    <div class="eem-body" v-else-if="loading">加载中…</div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { PhX } from '@phosphor-icons/vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { eventsApi } from '@/services/api'
import { useEventModalStore } from '@/stores/eventModal'
import { useEventEditForm, type EditingEvent } from '@/composables/useEventEditForm'
import EventEditFields from './EventEditFields.vue'

const eventModalStore = useEventModalStore()
const form = useEventEditForm()
const event = ref<EditingEvent | null>(null)
const loading = ref(false)

const show = computed(() => eventModalStore.openEventId != null)

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isPastDate(d: string | null | undefined) { return !!d && d < todayIso() }

async function load(id: number) {
  loading.value = true
  event.value = null
  try {
    const e = await eventsApi.get(id)
    event.value = {
      id: e.id, name: e.title, date: e.date ?? '', time: e.time || '', endTime: e.endTime || '',
      description: e.description || '', allDay: !e.time, version: e.version,
    }
    await form.loadReminders(event.value)
  } catch {
    close()
  } finally {
    loading.value = false
  }
}

watch(() => eventModalStore.openEventId, (id) => { if (id != null) load(id) })

function close() { eventModalStore.closeModal() }

async function onSave() {
  if (!event.value?.name) return
  try {
    await form.saveEvent(event.value)
    close()
  } catch (e: any) {
    if (e?.status === 409) alert('活动已被其他用户修改，请刷新页面')
  }
}
async function onDelete() {
  if (!event.value) return
  await form.deleteEvent(event.value.id)
  close()
}

const toastMsg = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
async function onTestReminder() {
  try {
    const res = await form.testReminderChannels(event.value?.name || '活动提醒')
    toastMsg.value = res?.msg || '已发送测试消息'
  } catch {
    toastMsg.value = '测试失败，请稍后重试'
  }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 3200)
}
</script>

<style scoped>
.eem-body { display: flex; flex-direction: column; gap: 9px; padding: 16px; }
.popup-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.popup-title { font-size: 13px; font-weight: 700; color: #1e2028; }
.popup-close-btn { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: none; border-radius: 6px; background: none; color: var(--text-secondary); cursor: pointer; }
.popup-close-btn:hover { background: rgba(0,0,0,0.06); }
.popup-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 2px; }
.popup-delete { padding: 5px 12px; border-radius: 8px; border: 1px solid rgba(176,120,88,0.3); background: rgba(176,120,88,0.08); font-size: 12px; cursor: pointer; color: #b07858; font-family: 'PingFang SC', 'Segoe UI', sans-serif; font-weight: 600; transition: background 0.12s, border-color 0.12s; }
.popup-delete:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); }
.popup-save { padding: 5px 14px; border-radius: 8px; border: none; background: linear-gradient(135deg,#7b7fb2,#9590c4); color: white; font-size: 12px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC', 'Segoe UI', sans-serif; transition: opacity 0.15s; box-shadow: 0 2px 8px rgba(123,127,178,0.28); }
.popup-save:disabled { opacity: 0.38; cursor: default; }
.popup-save:not(:disabled):hover { opacity: 0.88; }
.eem-toast { text-align: center; font-size: 11.5px; color: var(--text-secondary); }
</style>
