import { runtime } from './index'

let initialized = false

/** 应用只注册对象类型与统一运动参数，具体对象和 Surface 由各自组件声明。 */
export function setupInteractionRuntime(): void {
  if (initialized) return
  initialized = true

  runtime.registerObjectType('project-card', {
    defaultVisualMode: 'detach',
    motion: { enabled: true },
    // 抓取对齐沿用咕咕旧版（main 分支 usePhysicsDrag.ts）看板卡片的
    // centerGrab:true 手感：卡片几何中心对齐指针，再往下偏 12px 做出
    // "被拎着"的悬垂感，不是简单的居中或按点击位置对齐。
    grabAlign: { offsetY: 12 },
  })
  runtime.configureVisual({ dragGlass: true, layoutPresence: true })
  runtime.configureMotion({
    flip: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    resize: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    landing: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    group: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
  })
}
