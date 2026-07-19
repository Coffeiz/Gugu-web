import { runtime } from 'gugu-interaction-runtime'
import type { DragSession } from '../core/DragSession'

/**
 * 阶段 A：只让 Runtime 的 Session/Cleanup 跟现有拖拽引擎的生命周期并存，
 * 不接管任何视觉或状态机语义——`DragSession` 的 10 段 phase 跟 Runtime
 * Session 的状态不是一一对应关系，强行搬运每一次 setPhase() 只会在语义
 * 对不上时抛"非法状态转换"，反而让现有拖拽崩掉。这一阶段只验证一件事：
 * Runtime 能不能在真实项目卡拖拽场景里正常创建/结束一个 Session、不影响
 * 原有行为——为阶段 B/C 真正把跟手/落地逻辑收进 MoveBehavior 打地基。
 *
 * 只在源卡带 data-project-id 时创建，不影响文件/文件夹/画布贴纸这些还没
 * 排期迁移的拖拽场景——它们共用同一个 `single.ts` 引擎，但摸不到这段。
 */
export function bindProjectCardRuntimeSession(dragSession: DragSession, sourceEl: HTMLElement): void {
  const projectId = sourceEl.dataset.projectId
  if (!projectId) return
  const runtimeSession = runtime.startSession('project-card-move', projectId)
  dragSession.addCleanup(() => {
    if (runtimeSession.state !== 'disposed') runtime.endSession(runtimeSession)
  })
}
