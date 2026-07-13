<template>
  <!-- 抽屉本身就是那颗按钮——不是"按钮常驻 + 旁边再滑出一块面板"，而是按钮被点开后自己
       长大、变成面板，图标按钮全程都在，收起态时它是唯一内容，展开态时继续留在顶部当
       "新建"那一排的一部分。收起交互不是再点一次同一颗按钮（那颗按钮长在面板左上角，
       点它收起面板不够直观）——点面板以外任意地方（画布空白处/贴纸/工具条…）都会收起，
       同下拉菜单/弹层的通用手感一致。 -->
  <div ref="rootRef" class="canvas-drawer glass-card" :class="{ open: expanded }" @pointerdown.stop>
    <div class="cd-head">
      <button class="cd-toggle" title="画布列表" @click="expanded = !expanded">
        <PhSquaresFour :size="16" weight="bold" />
      </button>
      <span class="cd-title">画布</span>
      <button title="新建画布" class="cd-add" @click="onCreate"><PhPlus :size="15" weight="bold" /></button>
    </div>
    <!-- grid-template-rows: 0fr → 1fr 是给"高度可以从 0 平滑动画到内容实际高度（不确定
         具体像素值）"这件事的标准解法——直接 transition height 在目标是 auto 时没法生效，
         这一层只负责这段展开/收起过渡，不用再靠外层容器写死高度/百分比去凑。
         max-height 目标值改成逐帧量出来的真实内容高度（collapseMaxHeightPx），不再是固定
         写死的 55vh——55vh 通常比实际画布列表内容高得多，CSS transition 是照"目标值"的差量
         算进度的，画布数量一般用不满这截高度，max-height 还没插值到 55vh，box 的可视高度
         就已经被内容自身的高度顶到头、提前"到位"不再变化了，而横向宽度的过渡是从 36 到
         190 这两个跟内容无关的定值，会完整播满 0.28s——纵向看着"唰"一下先停了，横向还在
         继续张开，两个方向不是同时收尾，就是用户反馈的"纵向横向运动不是同时的"。改成量出
         真实内容高度（超出 55vh 那部分交给 .cd-list 自己的 overflow-y 滚动，这里封顶夹住，
         不让极端多画布时 max-height 目标值本身就超没边），横向纵向的过渡终点都是"这次动画
         真正会走到的那个值"，播满同一个 0.28s 才会看着是同一个动作。 -->
    <div class="cd-collapse" :style="{ maxHeight: expanded ? `${collapseMaxHeightPx}px` : '0px' }">
      <div class="cd-list" ref="cdListRef">
        <div v-for="canvas in canvases" :key="canvas.id" class="canvas-item" :class="{ active: canvas.id === activeId }" @click="onOpen(canvas.id)">
          <span v-if="renamingId === canvas.id" class="rename-sizer" @click.stop>
            <span class="rename-ghost">{{ renameText || ' ' }}</span>
            <input
              ref="renameInputRef" class="rename-input-inline" v-model="renameText"
              v-enter="() => commitRename(canvas.id)" @keydown.esc="cancelRename" @blur="commitRename(canvas.id)"
              @focus="($event.target as HTMLInputElement).select()"
            />
          </span>
          <span v-else class="ci-title">{{ canvas.title || '未命名画布' }}</span>
          <div class="ci-actions">
            <button
              :title="renamingId === canvas.id ? '确认' : '重命名'" class="ci-btn"
              @click.stop="renamingId === canvas.id ? commitRename(canvas.id) : startRename(canvas)"
            >
              <PhCheck v-if="renamingId === canvas.id" :size="11" weight="bold" />
              <PhPencilSimple v-else :size="11" weight="bold" />
            </button>
            <button title="删除画布" class="ci-btn ci-delete" @click.stop="onDelete(canvas)"><PhTrash :size="11" weight="bold" /></button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { PhCheck, PhPencilSimple, PhPlus, PhSquaresFour, PhTrash } from '@phosphor-icons/vue'
import type { MindCanvas } from '@/services/api'

defineProps({
  canvases: { type: Array as PropType<MindCanvas[]>, required: true },
  activeId: { type: Number as PropType<number | null>, default: null },
})
const emit = defineEmits<{
  (e: 'create'): void
  (e: 'open', id: number): void
  (e: 'delete', id: number): void
  (e: 'rename', id: number, title: string): void
}>()

// 默认收起——常驻一整块画布列表面板会一直占着画布右侧的可视区域，大多数时候用户只是在
// 当前画布上干活，不需要一直看着切换列表；改成贴边抽屉，需要切换/新建/删/改名画布才点开。
const expanded = ref(false)
const rootRef = ref<HTMLElement | null>(null)

// .cd-collapse 的展开目标高度：量 .cd-list 的真实内容高度（scrollHeight），封顶跟 CSS 里
// .cd-list 自己的 55vh 上限保持一致（超出部分交给它自己的 overflow-y 滚动，不让极端多画布
// 时这里算出的目标值本身失控）。ResizeObserver 盯 .cd-list 内容尺寸变化（建/删/改名画布都
// 会改变它），窗口 resize 单独听（55vh 这个上限本身是视口相对值，视口变了这个上限也要
// 跟着变，不属于 .cd-list 自身内容变化，ResizeObserver 感知不到）。
const cdListRef = ref<HTMLElement | null>(null)
const collapseMaxHeightPx = ref(0)
let cdListResizeObserver: ResizeObserver | null = null
function measureCollapseHeight() {
  const el = cdListRef.value
  if (!el) return
  collapseMaxHeightPx.value = Math.min(el.scrollHeight, window.innerHeight * 0.55)
}
onMounted(() => {
  const el = cdListRef.value
  if (el) {
    cdListResizeObserver = new ResizeObserver(measureCollapseHeight)
    cdListResizeObserver.observe(el)
  }
  measureCollapseHeight()
  window.addEventListener('resize', measureCollapseHeight)
})
onBeforeUnmount(() => {
  cdListResizeObserver?.disconnect()
  window.removeEventListener('resize', measureCollapseHeight)
})

function onOutsidePointerDown(event: PointerEvent) {
  if (!expanded.value) return
  const root = rootRef.value
  if (root && !root.contains(event.target as Node)) expanded.value = false
}
// 面板自己的 @pointerdown.stop 已经挡掉了点击面板内部时冒泡到这个 window 监听——这里只会
// 收到真正点在面板以外的事件，不用再手动判断"点的是不是自己人"。展开时才挂，收起时立刻
// 摘掉，画布空闲时不会一直有个全局监听器在空跑。
watch(expanded, (open) => {
  if (open) window.addEventListener('pointerdown', onOutsidePointerDown)
  else window.removeEventListener('pointerdown', onOutsidePointerDown)
})
onBeforeUnmount(() => window.removeEventListener('pointerdown', onOutsidePointerDown))

function onCreate() {
  emit('create')
}
function onOpen(id: number) {
  if (renamingId.value != null) return   // 正在改名时点条目本身不切换画布，避免误触打断输入
  emit('open', id)
}
function onDelete(canvas: MindCanvas) {
  // 画布容器一删，里面的贴纸摆放全部一并清空（见后端 delete_canvas 的注释：只是视图层，
  // 节点本身不受影响）——这是比"从画布移除单张贴纸"重得多的操作，需要一次确认，跟站内
  // 删除项目/文件夹/文件同一套 window.confirm 手感（见 ProjectModal.vue/Files/index.vue）。
  if (!window.confirm(`删除画布「${canvas.title || '未命名画布'}」？画布上的贴纸摆放将一并清空，此操作不可撤销。`)) return
  emit('delete', canvas.id)
}

// 改名输入框走全站共用的 .rename-sizer/.rename-ghost/.rename-input-inline 三件套（见
// global.css，ProjectModal.vue 的文件/文件夹改名同一套），自动撑开到文字实际宽度。
const renamingId = ref<number | null>(null)
const renameText = ref('')
const renameInputRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
function startRename(canvas: MindCanvas) {
  renamingId.value = canvas.id
  renameText.value = canvas.title || ''
  nextTick(() => {
    const el = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value
    el?.focus(); el?.select()
  })
}
function cancelRename() {
  renamingId.value = null
  renameText.value = ''
}
function commitRename(id: number) {
  if (renamingId.value !== id) return   // blur 和 v-enter 可能同时触发一次 commit，第二次已无对象
  const title = renameText.value.trim()
  renamingId.value = null
  if (!title) return
  emit('rename', id, title)
}
</script>

<style scoped>
/* 贴着画布可视区域（侧栏右缘～视口右缘）的右边缘、垂直居中——跟底部工具条
   （CanvasToolbar.vue）一样是浮层 UI，z-index 比侧栏（AppSidebar，20）低，靠自身贴右边缘
   天然不会落进侧栏底下（侧栏在左边），不用再像之前贴左上角那样额外加侧栏宽度的偏移量。
   宽度做过渡动画（收起态是一颗小方按钮，点开后自己长成完整面板宽度）；高度不整体参与
   过渡——那样得在容器上凑一个百分比/固定像素去配合 box-sizing:border-box 的 1px 玻璃
   边框，算错 2px 就会变成本次这种"看着是长方形"的走形。真正会动的只有下面 .cd-collapse
   这一段，用 grid-template-rows 单独处理。 */
.canvas-drawer {
  position: absolute; top: 50%; right: 12px; z-index: 8; transform: translateY(-50%);
  box-sizing: border-box; width: 36px; overflow: hidden;
  transition: width 0.28s cubic-bezier(0.34,1.2,0.64,1);
}
.canvas-drawer.open { width: 190px; }
/* cd-head 自己没有边框/内边距，box-sizing 用不用都一样；真正决定"收起态是不是正方形"的
   是它跟 .canvas-drawer 的宽度是否换算一致——.canvas-drawer 用 border-box 后 width:36px
   已经是含 1px 玻璃边框的最终尺寸，容器内容区实际可用宽度是 36-2=34px，这里高度也定 34px
   才能让收起态刚好是一枚正方形，不是宽高各自拍脑袋凑的数。 */
.cd-head { display: flex; align-items: center; height: 34px; flex-shrink: 0; }
.cd-toggle {
  flex-shrink: 0; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; background: none; color: var(--text-secondary); cursor: pointer;
}
.cd-toggle:hover { color: var(--color-primary); }
.canvas-drawer.open .cd-toggle { color: var(--color-primary); }
/* 收起态标题/新建按钮宽度归零裁掉（不是 display:none——那样在 width 过渡途中会瞬间消失/
   出现，跟宽度动画的渐进感对不上；改成随宽度一起被裁切，像是从窄缝里长出来的）。 */
.cd-title {
  flex: 1; min-width: 0; font-size: 12px; font-weight: 700; color: var(--text-secondary);
  overflow: hidden; white-space: nowrap; opacity: 0; transition: opacity 0.15s ease;
}
.canvas-drawer.open .cd-title { opacity: 1; transition-delay: 0.08s; }
.cd-add {
  flex-shrink: 0; width: 25px; height: 25px; margin-right: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; background: none; color: var(--text-secondary); cursor: pointer;
  opacity: 0; pointer-events: none; transition: opacity 0.15s ease;
}
.canvas-drawer.open .cd-add { opacity: 1; pointer-events: auto; transition-delay: 0.08s; }
.cd-add:hover { color: var(--color-primary); background: rgba(123,127,178,.11); }

/* grid-template-rows: 0fr→1fr 那套要求容器自己有确定的高度才能算出"可分配空间"，
   .canvas-drawer 偏偏是靠内容撑出来的 auto 高度（故意不写死，见上面的注释），fr 单位在
   没有确定高度的祖先里退化成按内容的 max-content 走，0fr 压不到真正的 0——收起态因此
   一直露着一截（用户反馈"看到 cd-collapse、变成竖着的长方形"）。改回更朴素但可靠的
   max-height 过渡：不追求跟内容高度分毫不差，但 0 就是真的 0，不依赖任何需要确定高度
   才成立的前提。展开态的目标值不再由这里的类选择器写死（曾经是 55vh），改成脚本里量出来
   的真实内容高度，见模板上的内联 :style 和 collapseMaxHeightPx 的注释——固定写死一个远
   超实际内容的值，会让这段过渡看着比横向宽度那条提前"到位"，两个方向不同步。 */
.cd-collapse {
  max-height: 0; overflow: hidden;
  transition: max-height 0.28s cubic-bezier(0.34,1.2,0.64,1);
}
.cd-list { box-sizing: border-box; max-height: 55vh; overflow-y: auto; padding: 0 9px 9px; }

.canvas-item { display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; height: 32px; padding: 0 4px 0 8px; border-radius: 6px; background: none; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.ci-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.canvas-item:hover { background: rgba(255,255,255,.55); }
.canvas-item.active { background: rgba(255,255,255,.86); color: var(--color-primary); font-weight: 700; box-shadow: 0 1px 3px rgba(60,70,100,.08); }
.rename-sizer { flex: 1; min-width: 0; }
/* 操作按钮悬停条目才显形（同便签/活动贴纸的 .ns-actions/.es-actions 手感），不常驻占地方——
   列表窄，常驻两个图标会让画布名更容易被截断。改名中的条目强制常驻（opacity:1），不然
   输入框还没提交，鼠标一移开按钮就隐形，找不到确认按钮。 */
.ci-actions { flex-shrink: 0; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.canvas-item:hover .ci-actions,
.canvas-item:has(.rename-input-inline) .ci-actions { opacity: 1; }
.ci-btn { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; border: 0; border-radius: 5px; background: none; color: var(--text-secondary); cursor: pointer; }
.ci-btn:hover { background: rgba(123,127,178,.16); color: var(--color-primary); }
.ci-delete:hover { background: rgba(200,90,90,.14); color: #c85a5a; }
</style>
