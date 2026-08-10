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
  // disableTargetVisualMorph：文件卡（FileCard.vue）和文件夹卡（FolderCard.vue）内部
  // 结构差异较大（不同组件、不同子节点布局），默认的"代理套上目标背景/圆角/内容"视觉 morph
  // 插值出不对齐的中间态，表现为拖入文件夹时图标/缩略图直接变成了文件夹本身，而不是带着
  // 自己的图标飞向文件夹再缩小消失。demo 的 file-item/folder-item 共用同一套内部结构，
  // morph 平滑不易察觉；咕咕这边关掉这段 morph，只保留位置和缩小淡出。
  // target 飞入/消失参数：消失（300ms ease-out、缩到 0.72）沿用 demo 调参面板的数值。
  // 飞入弹簧刚度/阻尼当前是 200/25（在测试阶段，先保留阻尼不变只提刚度）——
  // integrateSpring 是标准阻尼弹簧（a = k·(target-x) - c·v，质量隐含为 1），
  // 临界阻尼 = 2√k。200/25 的阻尼比 ζ = 25/(2√200) ≈ 0.88（欠阻尼，会有轻微
  // 过冲回弹，跟之前 100/25（ζ≈1.25，过阻尼）或 200/35（同比例的过阻尼版本，
  // ζ≈1.25）手感不同，目前在对比快速甩动时"贴合目标飞入"的弧线观感是否更接近
  // demo，还在调参阶段，不是最终值。
  // landing.duration/easing 这两个字段在 disableTargetVisualMorph:true 时基本不生效
  // （只驱动内容/背景 morph 的 CSS transition，这条路径被关掉了），位置动画完全由弹簧
  // 自己收敛决定，留着仅为字段完整性，不影响实际手感。
  const targetMotionProfile = {
    motion: {
      position: { stiffness: 200, damping: 25 },
      scale: { stiffness: 200, damping: 25 },
    },
    landing: { duration: 300, easing: 'ease-out' as const },
    dismiss: { duration: 300, easing: 'ease-out' as const, scale: 0.72 },
  }
  runtime.registerObjectType('file-item', {
    defaultVisualMode: 'detach',
    landingMode: 'target',
    motion: { enabled: true, profile: { target: targetMotionProfile } },
    preserveMoveTarget: true,
    disableTargetVisualMorph: true,
  })
  runtime.registerObjectType('folder-item', {
    defaultVisualMode: 'detach',
    landingMode: 'target',
    motion: { enabled: true, profile: { target: targetMotionProfile } },
    preserveMoveTarget: true,
    disableTargetVisualMorph: true,
  })
  runtime.configureVisual({ dragGlass: true, layoutPresence: true })
  runtime.configureMotion({
    flip: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    resize: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    landing: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    group: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
  })
}
