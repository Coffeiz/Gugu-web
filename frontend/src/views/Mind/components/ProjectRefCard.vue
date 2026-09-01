<template>
  <!-- 画布项目引用卡不再嵌 ProjectCard.vue 本体——看板项目卡承载了大量看板专属交互（优先级
       星级、推进阶段按钮、点阶段名弹待办列表、文件拖拽上传），画布这边只需要一份只读展示 +
       拖拽/建立关联，共享整个交互组件换来的是"看板改需求容易带崩画布、画布改样式容易带崩
       看板"（这次 squircle 圆角+加宽的误伤就是实例）。这里只共享没有 DOM 的纯展示逻辑
       （useProjectCardBasics：名字底色、阶段文案、进度、截止日期文案），显示层各写各的。 -->
  <div
    v-if="project"
    ref="cardEl"
    class="mind-project-card pr-card hover-card-fx"
    :class="{ connecting, 'connection-target': !!connectionTargetSide }"
    :style="cardStyle"
    :data-node-id="item.nodeId"
    :data-canvas-item-id="item.id"
    :data-project-id="item.node.refId"
    @pointerdown.stop="onPointerDown"
    @click.stop="onOpen"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <ProjectCardBody :project="project" />

    <CardAffordances :hovering="isHovering" :node-id="props.item.nodeId" :connecting="connecting" :target-side="connectionTargetSide" @connect-drag-start="(e, side) => emit('connectDragStart', e, side)">
      <template #actions>
      <button :title="t('filesUi.removeFromCanvas')" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
      </template>
      <template #connect />
    </CardAffordances>
  </div>
  <div v-else ref="missingRef" class="mind-project-card pr-missing hover-card-fx" :class="{ connecting, 'connection-target': !!connectionTargetSide }" :style="missingStyle" :data-node-id="item.nodeId" :data-canvas-item-id="item.id" :data-project-id="item.node.refId" @pointerdown.stop="onPointerDown" @click.stop="onOpen"
    @mouseenter="onEnter" @mouseleave="onLeave">
    <span class="pr-kind">{{ t('files.project') }}</span>
    <div class="pr-name" :style="{ color: snapshotNameColor }">{{ item.node.title || t('projects.projectName') }}</div>
    <!-- 客户/日期跟真实项目卡（ProjectCardBody 的 .proj-meta/.card-footer）同款字号/间距，
         数据来自创建引用时缓存的 ref_snapshot——项目被删只丢阶段/文件数这类高频变化的信息，
         客户和日期这种"当时是什么样"的快照还留着。没缓存到的字段各自不渲染，不留空行。 -->
    <div v-if="snapshot?.client" class="pr-client">{{ snapshot.client }}</div>
    <div v-if="snapshot?.startDate || snapshot?.deadline" class="pr-dates">
      <span v-if="snapshot.startDate" class="pr-date-start">{{ fmtDate(snapshot.startDate) }}</span>
      <span v-if="snapshot.startDate && snapshot.deadline" class="pr-date-sep">→</span>
      <span v-if="snapshot.deadline" class="pr-deadline" :class="{ urgent: snapshotIsUrgent }">{{ snapshotDeadlineLabel }}</span>
    </div>
    <!-- projectStore 还在拉取（DefaultLayout.vue 进 app 就发起，画布常是直接落地/刷新页面
         进来的入口，这次请求这时多半还没回来）跟"项目真的被删了"是两回事，但两者都会让
         project 算出来是 null、都会落进这条 v-else 分支——之前不分这两种情况，一律显示
         "已删除，仅保留快照"，缓存刚加载完那一下会先说谎再改口。跟 FileRefCard.vue 同一个
         坑（见其注释），这里只是文字层面的表现，不像文件卡那样有缩略图区带来的跳动。 -->
    <span class="pr-deleted">{{ projectStore.loading ? t('common.status.loading') : t('filesUi.deletedSnapshot') }}</span>
    <CardAffordances :hovering="isHovering" :node-id="props.item.nodeId" :connecting="connecting" :target-side="connectionTargetSide" @connect-drag-start="(e, side) => emit('connectDragStart', e, side)">
      <template #actions>
      <button :title="t('filesUi.removeFromCanvas')" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
      </template>
    </CardAffordances>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhTrash } from '@phosphor-icons/vue'
import type { MindCanvasItem } from '@/services/api'
import type { Project } from '@/types/project'
import { itemSize } from '@/composables/useMindCanvas'
import { useProjectCardBasics } from '@/composables/useProjectCardBasics'
import { useProjectStore } from '@/stores/projects'
import CardAffordances from '@/components/common/CardAffordances.vue'
const { t } = useI18n()
import ProjectCardBody from './ProjectCardBody.vue'
import { useMindRuntimeObject } from '../composables/useMindRuntimeObject'
import { MIND_PROJECT_OBJECT_TYPE } from '@/interaction/runtime/canvas'
import { mindCanvasObjectId } from '@/interaction/runtime/canvas'

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem>, required: true },
  connecting: { type: Boolean, default: false },
  connectionTargetSide: { type: String as PropType<'left' | 'right' | null>, default: null },
  screenToWorld: { type: Function as PropType<(clientX: number, clientY: number) => { x: number; y: number }>, required: true },
  scale: { type: Number, default: 1 },
})
const emit = defineEmits<{
  (e: 'remove', item: MindCanvasItem): void
  (e: 'returnToDrawer', item: MindCanvasItem): void
  (e: 'open', item: MindCanvasItem): void
  (e: 'connectDragStart', event: PointerEvent, side: 'left' | 'right'): void
  (e: 'measured', item: MindCanvasItem, size: { w: number; h: number }): void
  (e: 'hover', item: MindCanvasItem, hovering: boolean): void
}>()

// CardAffordances 用 prop 驱动外观（不是 CSS :hover），两个模板分支（有项目/
// 已删除墓碑）共用同一份悬停状态。
const isHovering = ref(false)
function onEnter() {
  isHovering.value = true
  emit('hover', props.item, true)
}
function onLeave() {
  isHovering.value = false
  emit('hover', props.item, false)
}

const projectStore = useProjectStore()
const project = computed(() => projectStore.projects.find(p => p.id === props.item.node.refId) || null)
// project 为 null（已删除对象）时走 v-else 的墓碑态，useProjectCardBasics 内部按 project.value
// 直接取字段，传一个占位对象兜底，反正这份 computed 在 project 为 null 时不会被模板用到。
const missingStyle = computed(() => {
  const { w } = itemSize(props.item)
  // 项目被删后拿不到活的 Project 记录，靠创建引用时缓存在 node.color 上的快照保留原本配色
  // （旧引用没有这份缓存时 color 是 null，回退到 .pr-missing 自己的默认底色）——跟正常态
  // cardStyle 用的是同一条渐变公式，快照要看起来"项目还在"，配色算法不能各写一套。
  const color = props.item.node.color
  // 高度不再用 item.h（项目还活着时最后一次量到的高度，通常带着 proj-meta/card-footer/
  // segbar 那些快照没有的内容撑出来的高度）强制 minHeight——快照展示的字段本来就比本体少，
  // 沿用旧高度会比同样内容量的本体卡片更高，让内容自己撑出高度，跟 cardStyle（本体，同样
  // 不设高度）保持一致。
  return {
    left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, zIndex: `${props.item.z}`,
    background: color ? `linear-gradient(to right, rgba(255,255,255,0.9) 0%, rgba(255,255,255,1) 40%), ${color}` : undefined,
  }
})
const cardStyle = computed(() => {
  const { w } = itemSize(props.item)
  return {
    left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, zIndex: `${props.item.z}`,
    '--pr-project-color': project.value?.color || undefined,
  }
})

// 已删除快照的客户/日期展示：复用 useProjectCardBasics 里跟真实项目卡完全相同的取色/
// 日期文案逻辑（nameColor/deadlineLabel/isUrgent 只依赖 color/deadline/status 三个字段，
// 不碰 stages），不在这里另抄一份格式化规则，避免两边日后各自改出不一致的日期文案。
// 只是喂给它一个用快照拼出来的假 Project（其余字段用不到，随手填安全默认值即可）。
const snapshot = computed(() => props.item.node.refSnapshot)
const snapshotProject = computed(() => ({
  color: props.item.node.color || '',
  deadline: snapshot.value?.deadline || null,
  status: snapshot.value?.status || 'active',
  stages: [], currentStage: null,
} as unknown as Project))
const { nameColor: snapshotNameColor, isUrgent: snapshotIsUrgent, fmtDate, deadlineLabel: snapshotDeadlineLabel } = useProjectCardBasics(snapshotProject)

// 项目卡高度随内容自然变化。关系线不再借持久化的 item.h 猜它多高，而是直接消费这张卡
// 上报的实际世界尺寸，避免视图模型和内层卡体两套高度彼此拉扯。
const cardEl = ref<HTMLElement | null>(null)
const missingRef = ref<HTMLElement | null>(null)
let cardResizeObserver: ResizeObserver | null = null
let lastMeasuredSize: { w: number; h: number } | null = null
function emitMeasuredSize() {
  // observeCard() 观察的是 cardEl.value ?? missingRef.value（项目被删后本体元素不存在，
  // 观察墓碑态自己），这里量尺寸却一直只读 cardEl.value——墓碑态下 cardEl 恒为 null，
  // 这个函数全程直接 return，measuredSizes 里这张卡的尺寸从此再没更新过，连线的
  // anchorFor 兜底公式用的是项目被删前最后一次量到的旧高度（通常带着 stage/segbar
  // 撑出来的高度），比墓碑态实际矮一截的卡片高，连接点算出来的位置就比真实圆点偏低。
  const card = cardEl.value ?? missingRef.value
  if (!card || !card.isConnected) return
  const rect = card.getBoundingClientRect()
  if (rect.width < 10 || rect.height < 10) return
  const scale = props.scale || 1
  const measured = { w: rect.width / scale, h: rect.height / scale }
  if (lastMeasuredSize
    && Math.abs(lastMeasuredSize.w - measured.w) < 0.01
    && Math.abs(lastMeasuredSize.h - measured.h) < 0.01) return
  lastMeasuredSize = measured
  emit('measured', props.item, measured)
}
function observeCard() {
  cardResizeObserver?.disconnect()
  lastMeasuredSize = null
  const card = cardEl.value ?? missingRef.value
  if (!card) return
  cardResizeObserver = new ResizeObserver(emitMeasuredSize)
  cardResizeObserver.observe(card)
  emitMeasuredSize()
}
onMounted(() => {
  // 父层在同一轮更新后就会向这张临时卡移交拖拽；这里不能再多包一层 nextTick，
  // 否则父层已经能查到 DOM、但启动器尚未注册，首次从抽屉拖出会被误判为“未加载”。
  observeCard()
})
watch(project, () => nextTick(observeCard))
watch(() => props.scale, () => nextTick(emitMeasuredSize))
onBeforeUnmount(() => {
  cardResizeObserver?.disconnect()
})

// 项目和文件贴纸统一由 Runtime 负责抓取、物理落地和重抓接管；项目回抽屉的目标
// Surface 由 MindCanvas 统一提交，组件只保留业务点击和展示职责。
const { onPointerDown } = useMindRuntimeObject({
  objectId: () => mindCanvasObjectId(props.item),
  element: () => cardEl.value ?? missingRef.value,
  objectType: MIND_PROJECT_OBJECT_TYPE,
  onClick: onOpen,
})
function onOpen() {
  emit('open', props.item)
}
</script>

<style scoped>
/* position:absolute（不是 relative）——跟便签/文件/活动贴纸的根节点一致（.note-sticker/
   .entity-sticker/.fr-wrap 都是 absolute），stickerStyle 给的 left/top 是世界坐标系的绝对
   位置。写成 relative 时 left/top 是"从正常文档流位置再偏移"，而 .canvas-world 宽高都是 0，
   块级元素在正常流里会跟其它同样 position:relative 的兄弟节点垂直堆叠——这份「正常流基准
   位置」会随画布上其它项目卡片的数量/高度变化，item.y 的偏移量就是加在一个不固定的基准上，
   越往后建的项目卡片、前面项目卡片越多/越高，累积偏差就越大。
   圆角只用 border-radius，不叠 corner-shape:squircle——文件卡/便签/活动贴纸这几种画布卡片
   都是普通圆角，项目卡跟着统一，不再各转各的曲线。overflow:visible 是因为连接点的判定区
   摆在卡片边缘外侧（见 CardAffordances.vue 的 .conn-dot-left/right），overflow:hidden 会把它们
   裁掉一半；背景渐变本身不需要 overflow:hidden 也会被自己的 border-radius 裁成圆角（元素
   自身背景永远贴合自己的盒子形状，overflow 管的是会溢出盒子的子元素/内容，不影响这点）。
   "正在建立关联"的虚线描边走 global.css 共用的 .connecting 规则，不再各卡自己声明。 */
.pr-card, .pr-missing {
  position: absolute; cursor: pointer;
  overflow: visible;
}
/* 悬停抬起/阴影加深走全局 .hover-card-fx（已加在模板类名里），但 scoped 样式编译后会带
   [data-v-xxx] 属性选择器，跟上面 .pr-card 静止态 box-shadow 那条一样特异度（类+属性选择
   器），跟全局 .hover-card-fx:hover（类+伪类，同样两级）打平——打平时看两份样式表谁在最终
   产物里排得靠后，不保真。FileCard.vue/EntitySticker.vue 都各自在 scoped 规则里重申一遍
   :hover 的阴影值来稳赢（不依赖顺序），这里补上同一份，否则会出现"看着没有 hover 阴影"
   （静止态那条声明打赢了 hover 态）。 */
/* SegBar.vue 自己的 @click.stop/@mousedown.stop 只挡 click/mousedown 这两种事件冒泡，挡不住
   CSS :active 伪类——按住进度条时鼠标底下的所有祖先（含 .pr-card 自己）都会同时进入 :active
   态，即使点击不会真的冒泡触发拖拽/翻开项目，卡片还是会跟着抖一下"按下"动画。全局
   .hover-card-fx:active:has(...) 那份共用名单没收 .seg-bar-wrap（board 侧的 ProjectCard.vue
   本来就单独有一条这个），这里单独补一份。 */
.pr-card:active:has(.seg-bar-wrap:active) { transform: none; opacity: 1; }

.pr-missing {
  padding: 13px 13px 11px;
  background: rgba(255,255,255,0.5);   /* 没有缓存颜色的旧引用兜底；有颜色时被行内 style 盖掉 */
  display: flex; flex-direction: column; gap: 8px;
  /* 不设 height：.pr-card（本体）就没有任何高度声明，靠 flex 子内容自然撑开。这里原来
     有一条 height:100%，父级（画布世界层）给不出一个确定的高度基准，实际处于「有效高度
     不确定」的悬空状态——一直是靠内联 minHeight（旧引用测量过的高度）兜底撑住才没露馅；
     minHeight 改成不再强制之后，height:100% 这条本身就有问题的规则直接暴露出来，卡片
     整个塌成一条窄条。去掉它，交给内容自然撑开，跟 .pr-card 保持同一套高度逻辑。
     不透明度/尺寸都跟 .pr-card 正常态一致——快照要看起来"项目还在"，不额外做变灰/变淡
     处理，"已删除"单靠 .pr-deleted 那行文字说明就够了。 */
}
/* 本体没有这个标签（一眼就能从内容看出是项目卡），但快照态缺了 stage/segbar 这类底部
   内容，整张卡显得偏空、偏矮，加一个补一点视觉分量，也顺带点出"这原本是个项目"。 */
.pr-kind { align-self: flex-start; padding: 1px 6px; border-radius: 4px; background: rgba(123,127,178,.12); color: var(--color-primary); font-size: 10px; font-weight: 700; }
/* 名称/客户/日期三行字号、行高跟 ProjectCardBody 的 .proj-name/.proj-client/.date-range
   逐条对齐（含颜色变量），不是照抄数值——真实卡片改这几个样式时这里要记得跟着改。 */
.pr-name { font-size: 13px; font-weight: 500; line-height: 1.35; overflow-wrap: anywhere; }
.pr-client { font-size: 11px; line-height: 1.15; color: var(--text-secondary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pr-dates { display: flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1.15; color: var(--text-secondary); }
.pr-date-start { opacity: 0.65; white-space: nowrap; }
.pr-date-sep { opacity: 0.35; font-size: 9px; }
.pr-deadline.urgent { color: var(--color-warning); font-weight: 600; }
.pr-deleted { font-size: 10.5px; color: var(--text-secondary); opacity: .7; }

/* 操作按钮（.card-actions）和连接点（.conn-dot）都由 CardAffordances.vue 提供，
   外观/悬停显形逻辑不再各卡自己抄一份。 */
</style>
