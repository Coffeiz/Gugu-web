import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 全局「活动编辑」弹窗开关：谁都能传个活动 id 把它弹出来（目前是笔记页的活动引用卡片），
 *  跟 projects store 的 modalProjectId 同一个模式——弹窗组件挂在 DefaultLayout，不用关心
 *  当前路由是不是日历页。 */
export const useEventModalStore = defineStore('eventModal', () => {
  const openEventId = ref<number | null>(null)
  function openModal(id: number) { openEventId.value = id }
  function closeModal() { openEventId.value = null }
  return { openEventId, openModal, closeModal }
})
