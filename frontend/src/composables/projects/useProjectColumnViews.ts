import { computed, reactive, type ComputedRef } from 'vue'
import type { Project, ProjectStatus } from '@/types/project'

interface ProjectColumnViewsOptions {
  projects: ComputedRef<Project[]>
  /** 未加载文件缓存时为 null；加载后以根目录文件数覆盖项目响应里的计数。 */
  liveFileCounts: ComputedRef<Map<number, number> | null>
}

/**
 * 项目看板的稳定列表投影。
 * 派生文件数不同时，视图对象必须保持响应式：卡片列表会复用数组和对象引用，
 * 因此普通浅拷贝无法把 Store 后续替换的 stages 通知到卡片。
 */
export function useProjectColumnViews(options: ProjectColumnViewsOptions) {
  const projectViewCache = new Map<number, { source: Project; view: Project }>()
  const columnListCache = new Map<ProjectStatus, Project[]>()

  const columnProjectsMap = computed(() => {
    const priorityValue = (project: Project) =>
      ({ high: 3, medium: 2, low: 1 }[project.priority ?? ''] ?? 0)
    const grouped = new Map<ProjectStatus, Project[]>()
    const liveIds = new Set<number>()
    const liveFileCounts = options.liveFileCounts.value

    for (const project of options.projects.value) {
      const list = grouped.get(project.status) ?? []
      const fileCount = liveFileCounts
        ? (liveFileCounts.get(project.id) ?? 0)
        : project.fileCount
      liveIds.add(project.id)

      const cached = projectViewCache.get(project.id)
      let view: Project
      if (fileCount === project.fileCount) {
        view = project
      } else if (cached?.source === project && cached.view !== project) {
        // 同步到响应式缓存对象；维持对象身份避免 TransitionGroup 卡片重挂载。
        Object.assign(cached.view, project, { fileCount })
        view = cached.view
      } else {
        view = reactive({ ...project, fileCount }) as Project
      }
      projectViewCache.set(project.id, { source: project, view })
      list.push(view)
      grouped.set(project.status, list)
    }

    for (const id of projectViewCache.keys()) {
      if (!liveIds.has(id)) projectViewCache.delete(id)
    }

    for (const [status, list] of grouped) {
      if (status === 'done') {
        list.sort((a, b) => priorityValue(b) - priorityValue(a) || (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
      } else if (status === 'active') {
        list.sort((a, b) => priorityValue(b) - priorityValue(a) || (a.deadline ?? '').localeCompare(b.deadline ?? '') || a.id - b.id)
      } else {
        list.sort((a, b) => priorityValue(b) - priorityValue(a) || (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.id - b.id)
      }
    }

    // 状态更新只会影响来源列和目标列；其它列复用数组，但列内的响应式项目视图
    // 可独立通知 ProjectCard 更新阶段、待办和进度等嵌套数据。
    const stableGrouped = new Map<ProjectStatus, Project[]>()
    for (const status of ['pending', 'active', 'done'] as const) {
      const next = grouped.get(status) ?? []
      const previous = columnListCache.get(status)
      const stable = previous
        && previous.length === next.length
        && previous.every((project, index) => project === next[index])
        ? previous
        : next
      columnListCache.set(status, stable)
      stableGrouped.set(status, stable)
    }
    return stableGrouped
  })

  function columnProjects(status: string): Project[] {
    return columnProjectsMap.value.get(status as ProjectStatus) ?? []
  }

  return { columnProjects, columnProjectsMap }
}
