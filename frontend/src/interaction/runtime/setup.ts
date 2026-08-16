import { runtime } from './index'
import { MIND_CANVAS_OBJECT_TYPE, MIND_PROJECT_OBJECT_TYPE, MIND_PROJECT_DRAWER_SURFACE_ID, MIND_CANVAS_DRAG_Z_INDEX, MIND_CANVAS_LANDING_Z_INDEX, resolveMindLandingRect, resolveMindLandingTarget } from './canvas'
import { TOP_Z } from '@/composables/windowz'

let initialized = false
let themeVisualObserver: MutationObserver | null = null

/** 应用只注册对象类型与统一运动参数，具体对象和 Surface 由各自组件声明。 */
export function setupInteractionRuntime(): void {
  if (initialized) return
  initialized = true

  runtime.registerObjectType('project-card', {
    defaultVisualMode: 'detach',
    affordances: { selector: '[data-card-affordances]' },
    groupVisual: 'default',
    motion: { enabled: true },
    // 抓取对齐沿用看板卡片既有的
    // centerGrab:true 手感：卡片几何中心对齐指针，再往下偏 12px 做出
    // "被拎着"的悬垂感，不是简单的居中或按点击位置对齐。
    grabAlign: { offsetY: 12 },
  })
  // 文件/文件夹卡片：落地目标是文件夹/面包屑这类语义容器。
  // 语义 target 由对象实例/独立 Target 注册，Surface 只描述自身的 grid/free 布局。
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
  // 列表行抓起时收成紧凑卡片，不带着整行 6 列宽的表格布局跟手飞。gridTemplateColumns
  // 跟 FilesListView.vue 里 .list-row 真实的列定义（2fr 90px 1.2fr 80px 72px 56px）
  // 轨道数量、类型完全一致——这样抓起/落地时浏览器是在给同一套列定义做数值插值，不是
  // 两套布局互相替换的瞬间跳变，字段落地时能精确回到本体行里真实的列位置。
  // 每一列紧凑值和真实值必须是同一种单位类型（fr↔fr 或 px↔px），浏览器才能连续插值；
  // 两边类型对不上的属性值是不可插值的，过渡到一半会直接瞬间跳变，不是连续变化（第 1、
  // 3 列——名称、项目阶段——本体是 fr，紧凑态也必须用 fr，不能改成 px，踩过一次坑：
  // 项目阶段改成固定 px 后单独跳变了一下，跟其它列的连续过渡对不上）。
  // 类型/项目阶段/大小三列不照抄本体的 90px/1.2fr/80px（那是给"MD"这种短徽章、"0 KB"
  // 这种短文本留了本体表格才需要的大量空白），收紧到接近内容实际宽度；日期/操作两列
  // 收到 0。这个字符串跟 FilesListView.vue 的列定义是耦合的，那边的列宽/列数一旦改动，
  // 这里要同步改。
  // selector 只匹配 .list-row，网格视图的 FolderCard/FileCard 不带这个 class，不受影响。
  const listProxyLayout = {
    compact: {
      selector: '.list-row',
      width: 'min(300px, calc(100vw - 48px))',
      gridTemplateColumns: '1.3fr 36px 1fr 44px 0px 0px',
    },
  }
  runtime.registerObjectType('file-item', {
    defaultVisualMode: 'detach',
    affordances: { selector: '[data-card-affordances]' },
    groupVisual: 'default',
    motion: { enabled: true, profile: { target: targetMotionProfile } },
    preserveMoveTarget: true,
    disableTargetVisualMorph: true,
    proxyLayout: listProxyLayout,
    // 文件可能从 20000+ 的 BaseModal 窗口中拖出。Runtime 默认 proxy 层级只有 1000，
    // 会被项目编辑卡压住；统一使用 windowz 的 TOP_Z 拖拽压顶带，不再另写魔法数。
    proxyZIndex: TOP_Z,
    landingProxyZIndex: TOP_Z,
  })
  runtime.registerObjectType('folder-item', {
    defaultVisualMode: 'detach',
    affordances: { selector: '[data-card-affordances]' },
    groupVisual: 'default',
    motion: { enabled: true, profile: { target: targetMotionProfile } },
    preserveMoveTarget: true,
    disableTargetVisualMorph: true,
    proxyLayout: listProxyLayout,
    proxyZIndex: TOP_Z,
    landingProxyZIndex: TOP_Z,
  })
  const registerMindObjectType = (objectType: string) => runtime.registerObjectType(objectType, {
    defaultVisualMode: 'detach',
    proxyZIndex: MIND_CANVAS_DRAG_Z_INDEX,
    landingProxyZIndex: ({ sourceSurfaceId, destinationSurfaceId }) => {
      if (destinationSurfaceId === MIND_PROJECT_DRAWER_SURFACE_ID) return MIND_CANVAS_DRAG_Z_INDEX
      if (sourceSurfaceId === MIND_PROJECT_DRAWER_SURFACE_ID) return MIND_CANVAS_DRAG_Z_INDEX
      return MIND_CANVAS_LANDING_Z_INDEX
    },
    affordances: { selector: '[data-card-affordances]' },
    // 画布和抽屉使用同一份项目卡结构。跨 Surface landing 保留拖拽代理的单层材质，
    // 不把抽屉根节点的 backdrop-filter:none 当成另一份目标内容套回代理，避免松手瞬间丢失 blur。
    disableTargetVisualMorph: true,
    camera: { enabled: true },
    releaseMode: 'physical',
    // 画布单独限制释放速度；该档案只在 free Surface 上读取，
    // 不会改变文件/项目列和语义目标 landing 的抛出手感。
    motion: {
      enabled: true,
      profile: {
        freeLanding: {
          duration: 550,
          easing: 'cubic-bezier(.22,1,.36,1)',
          coastSeconds: 0.12,
          maxCoast: 260,
          minVelocity: 30,
          release: { velocityScale: 1, maxVelocity: 2500 },
        },
      },
    },
    resolveFreeLandingRect: ({ objectId, destination }) => {
      const targetSurface = destination && typeof destination === 'object'
        ? (destination as { toSurfaceId?: unknown; columnId?: unknown }).toSurfaceId
          ?? (destination as { toSurfaceId?: unknown; columnId?: unknown }).columnId
        : null
      // 画布内是自由落点；进入抽屉时必须交给 drawer Surface 的语义目标，
      // 不能把鼠标释放点误当成抽屉卡的最终位置。
      if (targetSurface === MIND_PROJECT_DRAWER_SURFACE_ID) return null
      return resolveMindLandingRect(objectId, destination)
    },
    resolveMoveLandingTarget: ({ objectId, destination }) => resolveMindLandingTarget(objectId, destination),
  })
  registerMindObjectType(MIND_CANVAS_OBJECT_TYPE)
  registerMindObjectType(MIND_PROJECT_OBJECT_TYPE)

  // Runtime 的 dragGlass 是一套固定亮色 inline 视觉（白色背景/边框，且阴影是 inline
  // !important）。亮色继续保留原来的抓起手感；暗色关闭这层 Runtime paint，让 clone
  // 保留真实卡片的暗色视觉，再由宿主 --runtime-drag-* contract 负责主题表面。这样不需要
  // 用业务 CSS 去对抗 inline !important，也不改 Runtime 的跟手/landing/物理算法。
  const syncRuntimeVisualTheme = () => {
    const dark = document.documentElement.dataset.theme === 'dark'
    runtime.configureVisual({ dragGlass: !dark, layoutPresence: true })
  }
  syncRuntimeVisualTheme()
  if (!themeVisualObserver) {
    themeVisualObserver = new MutationObserver(syncRuntimeVisualTheme)
    themeVisualObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
  }

  runtime.configureMotion({
    flip: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    resize: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    landing: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    group: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
  })
}
