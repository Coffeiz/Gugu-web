import { computed, ref } from 'vue'
import { cloneProjectStages } from '@/utils/projectStages'
import type { Project, ProjectStage } from '@/types/project'

/**
 * 项目编辑草稿的统一状态。
 *
 * 这里暂时只负责草稿字段和初始化；保存、取消以及跨面板协调仍由
 * ProjectModal 编排，避免第一步重构同时改变现有保存时序。
 */
export function useProjectDraft() {
  const localName = ref('')
  const localStages = ref<ProjectStage[]>([])
  const localStartDate = ref('')
  const localDeadline = ref('')
  const localClient = ref('')
  const localColor = ref('')
  const localCurrentStage = ref('')
  // 看板列配置目前返回普通 string；项目状态的领域收紧留给后续类型边界处理。
  const localStatus = ref('')
  const baseline = ref('')

  const isDirty = computed(() => JSON.stringify({
    name: localName.value,
    stages: localStages.value,
    startDate: localStartDate.value,
    deadline: localDeadline.value,
    client: localClient.value,
    color: localColor.value,
    currentStage: localCurrentStage.value,
    status: localStatus.value,
  }) !== baseline.value)

  function snapshot() {
    return JSON.stringify({
      name: localName.value,
      stages: localStages.value,
      startDate: localStartDate.value,
      deadline: localDeadline.value,
      client: localClient.value,
      color: localColor.value,
      currentStage: localCurrentStage.value,
      status: localStatus.value,
    })
  }

  function reset(project: Project | null) {
    localName.value = project?.name ?? ''
    localStages.value = project ? cloneProjectStages(project.stages) : []
    localStartDate.value = project?.startDate ?? ''
    localDeadline.value = project?.deadline ?? ''
    localClient.value = project?.client ?? ''
    localColor.value = project?.color ?? ''
    localCurrentStage.value = project?.currentStage ?? ''
    localStatus.value = project?.status ?? 'pending'
    baseline.value = snapshot()
  }

  function markSaved() {
    baseline.value = snapshot()
  }

  return {
    localName,
    localStages,
    localStartDate,
    localDeadline,
    localClient,
    localColor,
    localCurrentStage,
    localStatus,
    isDirty,
    reset,
    markSaved,
  }
}
