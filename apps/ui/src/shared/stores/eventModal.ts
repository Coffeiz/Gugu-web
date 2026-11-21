import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface EventFloatingPosition {
  left: number
  top: number
  width: number
}

export interface EventModalOptions {
  floating?: boolean
  position?: EventFloatingPosition
}

/** 全局「活动编辑」弹窗开关：谁都能传个活动 id 把它弹出来（目前是笔记页的活动引用卡片），
 *  跟 projects store 的 modalProjectId 同一个模式——弹窗组件挂在 DefaultLayout，不用关心
 *  当前路由是不是日历页。 */
export const useEventModalStore = defineStore('eventModal', () => {
  const openEventId = ref<number | null>(null)
  const floating = ref(false)
  const floatingPosition = ref<EventFloatingPosition | null>(null)
  function openModal(id: number, options: EventModalOptions = {}) {
    openEventId.value = id
    floating.value = options.floating === true
    floatingPosition.value = options.position ?? null
  }
  function closeModal() {
    openEventId.value = null
    floating.value = false
    floatingPosition.value = null
  }
  return { openEventId, floating, floatingPosition, openModal, closeModal }
})
