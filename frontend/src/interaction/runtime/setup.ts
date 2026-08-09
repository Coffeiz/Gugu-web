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
  // 文件/文件夹卡片：落地目标是文件夹/面包屑这类语义容器，用 landingMode:'target'
  // 让代理松手后从第一帧开始缩小淡出，同时继承 landing 的释放速度、旋转与位置运动
  // （效果基准是 gugu-interaction-runtime demo FileSystemDemo.vue，不迁移旧手感）。
  runtime.registerObjectType('file-item', {
    defaultVisualMode: 'detach',
    landingMode: 'target',
    motion: { enabled: true },
    preserveMoveTarget: true,
  })
  runtime.registerObjectType('folder-item', {
    defaultVisualMode: 'detach',
    landingMode: 'target',
    motion: { enabled: true },
    preserveMoveTarget: true,
  })
  runtime.configureVisual({ dragGlass: true, layoutPresence: true })
  runtime.configureMotion({
    flip: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    resize: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    landing: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    group: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
  })
}
