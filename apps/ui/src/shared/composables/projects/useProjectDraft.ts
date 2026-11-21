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

  type DraftFields = {
    name: string; stages: ProjectStage[]; startDate: string; deadline: string
    client: string; color: string; currentStage: string; status: string
  }

  function _fields(project: Project | null): DraftFields {
    return {
      name: project?.name ?? '',
      stages: project ? cloneProjectStages(project.stages) : [],
      startDate: project?.startDate ?? '',
      deadline: project?.deadline ?? '',
      client: project?.client ?? '',
      color: project?.color ?? '',
      currentStage: project?.currentStage ?? '',
      status: project?.status ?? 'pending',
    }
  }

  const _fieldRefs = {
    name: localName, stages: localStages, startDate: localStartDate,
    deadline: localDeadline, client: localClient, color: localColor,
    currentStage: localCurrentStage, status: localStatus,
  }

  /** 外部（Agent/IM）修改项目时按字段同步进打开中的草稿。
   *
   * 用户没动过的字段直接采用服务端最新值并更新 baseline（不产生脏标记）；
   * 用户已本地修改的字段保留草稿、只把 baseline 推进到服务端值——保存时
   * 仍是用户的编辑胜出。避免「弹窗开着，咕咕在 IM 里改了阶段/待办，
   * 界面一直停在打开时的快照」。 */
  function syncExternal(project: Project | null) {
    const next = _fields(project)
    let baselineObj: Partial<Record<keyof DraftFields, unknown>> = {}
    try { baselineObj = JSON.parse(baseline.value || '{}') } catch { baselineObj = {} }
    for (const key of Object.keys(next) as (keyof DraftFields)[]) {
      const untouched = JSON.stringify(_fieldRefs[key].value) === JSON.stringify(baselineObj[key])
      if (untouched) {
        _fieldRefs[key].value = key === 'stages'
          ? cloneProjectStages(next.stages)
          : next[key]
      }
      baselineObj[key] = next[key]
    }
    baseline.value = JSON.stringify(baselineObj)
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
    syncExternal,
  }
}
