import { ref, watch, type Ref } from 'vue'

type PreferencesLike = {
  loaded: Ref<boolean>
  pmStagesExpanded: Ref<boolean>
  savePmStagesExpanded: (value: boolean) => void | Promise<void>
}

/** 管理项目编辑卡左右布局的偏好同步与切换锁。 */
export function useProjectModalLayout(preferences: PreferencesLike) {
  const stagesExpanded = ref(preferences.pmStagesExpanded.value)
  const infoExpanded = ref(preferences.pmStagesExpanded.value)
  const switching = ref(false)

  watch(preferences.loaded, loaded => {
    if (loaded) {
      stagesExpanded.value = preferences.pmStagesExpanded.value
      infoExpanded.value = preferences.pmStagesExpanded.value
    }
  })

  function toggle() {
    if (switching.value) return
    const duration = 360
    switching.value = true
    requestAnimationFrame(() => {
      stagesExpanded.value = !stagesExpanded.value
      infoExpanded.value = stagesExpanded.value
      preferences.savePmStagesExpanded(stagesExpanded.value)
      setTimeout(() => { switching.value = false }, duration)
    })
  }

  return { stagesExpanded, infoExpanded, switching, toggle }
}
