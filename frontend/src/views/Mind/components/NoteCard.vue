<template>
  <div ref="cardRef" class="note-card"
       :class="{ editing, highlight, 'nc-edit-pending': editing && !editReady, 'canvas-mode': canvasMode, 'hover-card-fx': canvasMode && !editing, connecting, 'connection-target': !!connectionTargetSide, ['tint-' + (note.color || '')]: !!note.color }"
       :style="{ height: cardHeight }"
       @mouseenter="isHovering = true" @mouseleave="isHovering = false">
    <!-- 编辑态：跟只读态一样按区域分标题区/正文区（不是靠"标题"文字样式段落类型），
         就地展开（跨两列由父级 grid-column 控制）；自动保存，主要退出方式是点卡外面
         （先补一次保存再退出）——但"点外面"这个出口不够显眼（画布上尤其容易让人以为
         点哪都在编辑器范围内，找不到退出的地方），补一个常驻的"完成"按钮兜底。 -->
    <template v-if="editing">
      <input
        ref="titleInputRef" @pointerdown.stop
        v-model="draftTitle" class="nc-title-input" placeholder="标题（可选）"
        @keydown.enter.prevent="bodyEditorRef?.focus()"
      />
      <!-- pendingFocus 有具体目标（标题/某一行）时不让编辑器自己 autofocus:'end'——它内部的
           自动聚焦是异步触发的，晚于下面 watch 里 nextTick 后的手动定位，会把光标又抢回文档
           末尾。只有默认进编辑态（没有具体点击目标）才用它自己的 autofocus。
           @pointerdown.stop：画布贴纸场景下这张卡的根节点是可拖拽的（见 NoteSticker.vue），
           在编辑器里点字/选字/点工具栏不该被外层拖拽阈值判定拦截——列表页没有拖拽，加这个
           不影响原有行为。 -->
      <NoteEditor ref="bodyEditorRef" v-model="draftBody" :autofocus="pendingFocus === null"
                  :float-toolbar="canvasMode" :edit-ready="editReady"
                  @submit="finishEditing" @pointerdown.stop>
        <template #foot-actions>
          <span v-if="conflict" class="nc-conflict">改动冲突，已刷新</span>
          <button class="nc-done-btn" @pointerdown.stop @click.stop="finishEditing" title="完成编辑">
            <PhCheck :size="12" weight="bold" /> 完成
          </button>
        </template>
      </NoteEditor>
    </template>

    <!-- 只读态：真标题（# 打头）才单独摘出来放头部；纯正文/待办/列表整段就是正文，
         不凭空造一条"标题"，编辑/删除按钮改浮在卡右上角。hover 出编辑/删除 -->
    <template v-else>
      <div v-if="isHeading" class="nc-head">
        <span class="nc-title" @click="startEditAt('title')">{{ title }}</span>
        <CardAffordances :hovering="isHovering && !editing" actions-placement="inline" :node-id="null">
          <template #actions>
          <ColorSwatches :model-value="note.color" :allow-none="!canvasMode" @update:model-value="c => emit('color', c)" />
          <button class="nc-icon" title="编辑" @pointerdown.stop @click.stop="startEditAt(null)">
            <PhPencilSimple :size="12" weight="bold" />
          </button>
          <button class="nc-icon danger" title="删除" @pointerdown.stop @click.stop="emit('delete')">
            <PhTrash :size="12" weight="bold" />
          </button>
          </template>
        </CardAffordances>
      </div>
      <CardAffordances v-else :hovering="isHovering && !editing" actions-placement="float" :node-id="null">
        <template #actions>
        <ColorSwatches :model-value="note.color" :allow-none="!canvasMode" @update:model-value="c => emit('color', c)" />
        <button class="nc-icon" title="编辑" @pointerdown.stop @click.stop="startEditAt(null)">
          <PhPencilSimple :size="12" weight="bold" />
        </button>
        <button class="nc-icon danger" title="删除" @pointerdown.stop @click.stop="emit('delete')">
          <PhTrash :size="12" weight="bold" />
        </button>
        </template>
      </CardAffordances>
      <div v-if="bodyMd" ref="bodyRef" class="nc-body md-preview" :class="{ clamped: clamped && !expanded }"
           @click="onBodyClick" v-html="previewHtml"></div>
      <button v-if="clamped" class="nc-expand" @pointerdown.stop @click.stop="expanded = !expanded">
        {{ expanded ? '收起' : '展开' }}
      </button>
    </template>
    <!-- 连接点只有画布模式才有，并且保持在 NoteCard 自己的 DOM 子树里，确保拖拽克隆时
         子树里，不是 NoteSticker.vue 那层壳的兄弟节点）是关键——拖拽克隆 cloneNode(true)
         只拷贝这张卡自己的 DOM 子树，连接点得是这棵子树的真子集，才能跟着克隆体一起飞、
         跟文件/活动/项目引用卡三种画布卡片同样的路数（见 NoteSticker.vue 的说明）。 -->
    <CardAffordances
      v-if="canvasMode"
      :node-id="note.id" :hovering="isHovering && !editing" :connecting="connecting ?? false" :target-side="connectionTargetSide ?? null"
      @connect-drag-start="(e, side) => emit('connect-drag-start', e, side)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhCheck, PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import { combineTitleBody, mdToPreviewHtml } from '@/composables/useMindEditor'
import { useMindRefActions } from '@/composables/useMindRefActions'
import type { MindNote } from '@/services/api'
import CardAffordances from '@/components/common/CardAffordances.vue'
import ColorSwatches from './ColorSwatches.vue'
import NoteEditor from './NoteEditor.vue'

// Markdown 预览会在时间轴卡片、画布卡片之间复用相同正文。按正文缓存有限数量的 HTML，避免
// 实时刷新或卡片重新挂载时重复做代码高亮；限制容量避免长期编辑造成无界内存增长。
const PREVIEW_CACHE_LIMIT = 256
const previewCache = new Map<string, string>()
function cachedPreviewHtml(md: string): string {
  const cached = previewCache.get(md)
  if (cached !== undefined) return cached
  const html = mdToPreviewHtml(md)
  previewCache.set(md, html)
  if (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value
    if (oldest !== undefined) previewCache.delete(oldest)
  }
  return html
}

const { openMindRef, resolveMindRef } = useMindRefActions()

const props = defineProps<{
  note: MindNote
  editing: boolean
  highlight: boolean
  conflict: boolean
  // 画布便签（NoteSticker.vue）用这个把材质换回纸感——不透明的纸色/纯色淡染，跟笔记页
  // 时间流里半透明的玻璃质感（.note-card 默认背景）刻意区分开：无限画布上贴纸叠贴纸的
  // 场合，半透明会互相透出底下别的贴纸内容，看着很乱；便签本来就该是"不透明的实体小卡片"
  // （NoteSticker.vue 原来的说法）。不传按笔记页的玻璃质感走，不影响原有页面。
  canvasMode?: boolean
  // 画布相机当前缩放（MindCanvas.vue 的 camera.scale）——spawnToolbarGhost 需要它把
  // getBoundingClientRect 量出的屏幕像素差值换回世界坐标像素，见该函数内的换算注释。
  // 笔记页时间流没有缩放祖先，不传按 1 处理，换算是 no-op。
  scale?: number
  // 建立关联相关——只有画布模式会用（笔记页时间流不支持连线），见下面 CardAffordances 的
  // v-if="canvasMode"。NoteSticker.vue 原样转发 MindCanvas.vue 给它的同名 prop。
  connecting?: boolean
  connectionTargetSide?: 'left' | 'right' | null
}>()

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'close'): void
  (e: 'save', md: string): void
  (e: 'delete'): void
  (e: 'color', color: string | null): void
  (e: 'toggle-task', idx: number): void
  (e: 'connect-drag-start', event: PointerEvent, side: 'left' | 'right'): void
}>()

// CardAffordances 用 prop 驱动外观（不是 CSS :hover）——只有画布模式才传入 node-id，
// 便签页时间流因此不会渲染连接点。
const isHovering = ref(false)

// 编辑态按区域拆成标题草稿 + 正文草稿（对齐只读态的 nc-head/nc-body 分区），
// 存的时候再拼回 `# 标题\n正文` 这套跟只读态解析约定一致的单串 markdown。
const draftTitle   = ref('')
const draftBody    = ref('')
// 退出编辑时，store 的异步回写还没来得及更新 props.note。预览若立刻读旧正文，卡片高度会
// 先按旧内容收起、等回写后再突然变一次。暂存刚退出时的草稿，让预览和目标高度在同一帧就以
// 新内容计算；外部回写（或冲突后的刷新）抵达后再交还给 props.note。
const pendingPreviewMd = ref<string | null>(null)
const displayContentMd = computed(() => pendingPreviewMd.value ?? props.note.contentMd ?? '')
const expanded     = ref(false)
const clamped      = ref(false)
const bodyRef      = ref<HTMLElement | null>(null)
const cardRef      = ref<HTMLElement | null>(null)
const bodyEditorRef = ref<InstanceType<typeof NoteEditor> | null>(null)
// 编辑器初始光标落点是异步的（不管默认 autofocus:'end' 还是我们手动定位），刚挂载那一瞬间
// 可能先落在文档默认位置（比如正文开头是待办，就会先亮一下待办的样式）再跳到正确位置。
// 定位真正落定前先把整张卡藏起来（保留布局占位，不闪跳），避免这个过渡态被看见。
const editReady = ref(false)
// 编辑/预览切换的展开收回动画：v-if 直接换整块内容，高度没法从/到 auto 做过渡（CSS 不
// 支持），所以手动量出切换前后两个真实高度，冻结成具体 px 值再过渡，动画播完再放回 auto——
// 不然预览态里后续「展开/收起」长内容、编辑态里继续打字撑高，都会被钉死在这个旧的 px 值上。
const cardHeight = ref<string>('auto')
const HEIGHT_ANIM_MS = 190   // 跟下面 .note-card 的 height 过渡时长保持一致
// 退出编辑态时工具栏的模糊淡出：真实工具栏马上要被 v-if 摘掉，自己没法播 transition，
// 所以摘之前先克隆一份浮在原地继续淡出，跟下面的收起动画同时开始（见 spawnToolbarGhost）。
const TOOLBAR_FADE_MS = 110
const titleInputRef = ref<HTMLInputElement | null>(null)
// 点哪进编辑态光标就落在哪：'title' 落标题框，数字落正文对应行（跟 mdToPreviewHtml 的
// data-line-unit 对应），null 就随 NoteEditor 自己的 autofocus:'end'（默认落文档末尾）。
const pendingFocus = ref<'title' | number | null>(null)
function startEditAt(target: 'title' | number | null) {
  pendingFocus.value = target
  emit('edit')
}

function serializeDraft(): string {
  return combineTitleBody(draftTitle.value, draftBody.value)
}

/** 自动保存：停顿 AUTOSAVE_MS 没再改就存一次；不再有手动「保存」这个动作。 */
const AUTOSAVE_MS = 900
let saveTimer: ReturnType<typeof setTimeout> | null = null
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const md = serializeDraft()
  if (md !== props.note.contentMd) emit('save', md)
}
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, AUTOSAVE_MS)
}
watch([draftTitle, draftBody], () => { if (props.editing) scheduleSave() })
watch(() => props.note.contentMd, () => {
  if (!props.editing) pendingPreviewMd.value = null
})

/** 点卡片外面：先补一次保存，再退出编辑态（不再是「取消」，没有可丢弃的东西）。
 *  NoteEditor 的「样式」「插入」抽屉是原地展开、卡片的真实 DOM 后代，点里面的按钮天然
 *  会被 cardRef.contains() 认成"没点外面"，不用再单独放行。
 *  `@` 引用补全下拉和画布便签的浮动工具栏（floatToolbar，见 NoteEditor.vue）都是例外——
 *  两者都 Teleport 到了 body（前者躲避卡片 overflow:hidden 的裁切，后者躲避画布便签
 *  太窄装不下横排图标），点它们天然不在 cardRef 内，得单独放行，不然点下拉选项/工具栏
 *  按钮那一刻会先被这里判成"点外面"触发 finishEditing/editor 卸载，choose() 或工具栏的
 *  点击处理再执行时 editor.value 已经是 null（`@` 下拉那边踩过：TypeError: Cannot read
 *  properties of null (reading 'chain')）。 */
function onDocDown(e: MouseEvent) {
  if (!props.editing) return
  const t = e.target as HTMLElement
  if (cardRef.value?.contains(t) || t.closest('.ne-picker') || t.closest('.ne-toolbar-floating')) return
  finishEditing()
}
// finishEditing 已经同步 flush 过一次；emit('close') 会让 editing 变 false 反过来触发下面
// 那个 watch，此时保存请求可能还没落地、props.note.contentMd 还是旧值，若 watch 再 flush
// 一次会拿同一份 draft、同一个旧 version 再发一次 PATCH——自己把自己撞出 409。这个标记
// 就是防止同一次关闭被 flush 两遍。
let closedByFinish = false
function finishEditing() {
  closedByFinish = true
  flushSave()
  emit('close')
}

/** 工具栏收起淡出：真实 .ne-toolbar 马上要被 v-if 摘掉，没法自己播 transition——摘之前
 *  克隆一份、定位在原处叠一层继续做模糊淡出，跟卡片的收起动画同时开始（都是 editing 变
 *  false 那一刻触发，互不等待），播完自己从 DOM 里清掉。卡片本身还在同步缩小，克隆节点
 *  的定位是固定像素值，缩到比它矮时会被 .note-card 的 overflow:hidden 提前裁掉一截，
 *  这是几何上跑不掉的（收起动画目标高度本来就比编辑态矮），可以接受。
 *  ⚠️ 两种工具栏要接两套完全不同的坐标系，不能共用一份定位公式：
 *  - 非浮动（列表/时间流）：真实 .ne-toolbar 本来就是卡片的 DOM 后代，活在 cardEl 的
 *    局部坐标系下；画布场景里 cardEl 自己还套着 .canvas-world 的 transform:
 *    scale(camera.scale) 祖先。ghost 挂回 cardEl 内部延续同一套局部坐标，但
 *    getBoundingClientRect 量出来的 cardRect/toolbarRect 已经是缩放后的屏幕坐标，
 *    直接拿屏幕差值原样赋给 ghost 的 CSS 会被这层祖先缩放二次叠加，除以 scale 换回
 *    局部单位才能让 ghost 准确贴在原位置（缩放 100% 之外会飘走）。
 *  - 浮动（画布便签，floatToolbar）：真实工具栏 Teleport 到了 body，活在 .canvas-world
 *    缩放祖先之外——不管画布怎么缩放，它的图标/文字都是恒定的屏幕像素大小，只有位置
 *    跟着卡片走（见 NoteEditor.vue 的 updateFloatToolbarPos）。ghost 要延续同一套"屏幕
 *    像素、不随画布缩放"的坐标系，因此也要挂在 body 上、直接用 toolbarRect 的屏幕坐标，
 *    不能套用非浮动那份除以 scale 的公式——那是给"活在缩放祖先里的元素"补偿用的，套在
 *    一个根本不在缩放祖先里的元素上会把缩放系数二次带进来，画布缩放不是 100% 时
 *    ghost 的视觉大小就会跟着莫名其妙放大/缩小（局部宽度被除以/乘以 scale 撑大或压小，
 *    子元素图标却还是原始像素尺寸不跟着变，两者对不上；这份局部宽度又要再经过缩放祖先
 *    的 transform 二次缩放一遍，误差就是这么来的）。 */
function spawnToolbarGhost() {
  const cardEl = cardRef.value
  // 浮动工具栏（画布便签）Teleport 到了 body，不再是 cardEl 的 DOM 后代，querySelector
  // 找不到它，得从 NoteEditor 自己手上要（见其 defineExpose 的 getToolbarEl）；非浮动
  // 场景仍退回原来的 querySelector，两边都要兜住。cardEl.contains() 顺带用来判断此刻
  // 到底是哪种坐标系——不猜 canvasMode，直接问真实 DOM 关系最可靠。
  const toolbarEl = bodyEditorRef.value?.getToolbarEl() ?? cardEl?.querySelector<HTMLElement>('.ne-toolbar')
  if (!cardEl || !toolbarEl) return
  const floating = !cardEl.contains(toolbarEl)
  const toolbarRect = toolbarEl.getBoundingClientRect()
  const ghost = toolbarEl.cloneNode(true) as HTMLElement
  ghost.style.margin = '0'
  ghost.style.pointerEvents = 'none'
  ghost.style.opacity = '1'
  ghost.style.filter = 'blur(0)'
  ghost.style.transition = `opacity ${TOOLBAR_FADE_MS}ms ease-in-out, filter ${TOOLBAR_FADE_MS}ms ease-in-out`
  if (floating) {
    // 直接原样搬到 body 上，用真实屏幕坐标——跟真工具栏此刻的定位方式完全一致，不涉及
    // 任何缩放换算。cloneNode 连 .ne-toolbar-floating 的 transform:translateX(-50%) 也
    // 一起拷贝过来了，但 toolbarRect.left 已经是套完那份变换之后的最终屏幕左边缘，
    // 清空 transform 才是真正的最终位置，不需要再居中一次。
    ghost.style.position = 'fixed'
    ghost.style.zIndex = '2000'
    ghost.style.left = `${toolbarRect.left}px`
    ghost.style.top = `${toolbarRect.top}px`
    ghost.style.transform = 'none'
    document.body.appendChild(ghost)
  } else {
    const scale = props.scale || 1
    const cardRect = cardEl.getBoundingClientRect()
    ghost.style.position = 'absolute'
    ghost.style.zIndex = '2'
    ghost.style.left = `${(toolbarRect.left - cardRect.left) / scale}px`
    ghost.style.top = `${(toolbarRect.top - cardRect.top) / scale}px`
    ghost.style.width = `${toolbarRect.width / scale}px`
    cardEl.appendChild(ghost)
  }
  requestAnimationFrame(() => {
    ghost.style.opacity = '0'
    ghost.style.filter = 'blur(6px)'
  })
  setTimeout(() => ghost.remove(), TOOLBAR_FADE_MS + 20)
}

// 进入编辑时灌当前内容为草稿；退出时（点外面/切换到别的便签走 finishEditing 之外的路径，
// 比如便签被删除强制退出编辑）才需要这里兜底补一次保存。编辑期间才挂全局点击监听，
// 避免每张卡常驻一个 document 监听器。
let heightResetTimer: ReturnType<typeof setTimeout> | null = null
watch(() => props.editing, async (v, prev) => {
  // watch 默认 flush:'pre'，这一刻卡片还是切换前的内容（v-if 还没跑），先量出旧高度当动画起点。
  // 用 offsetHeight 不用 getBoundingClientRect——后者是变换后的视口尺寸，边缘日期卡点开时
  // 列本身还在做居中的 translateX+scale 动画，取到的高度会跟着这个瞬时缩放值一起抖，量出来
  // 的起点/终点对不上，卡片自己的收起/展开动画就跟着弹一下。offsetHeight 是纯布局尺寸，
  // 不受祖先 transform 影响，边缘列也能量得准。
  if (heightResetTimer) { clearTimeout(heightResetTimer); heightResetTimer = null }
  const el = cardRef.value
  const startH = el?.offsetHeight ?? null

  if (v) {
    closedByFinish = false
    editReady.value = false
    draftTitle.value = _split.value.titleRaw
    draftBody.value = _split.value.body
    document.addEventListener('mousedown', onDocDown, true)
    await nextTick()   // 等 NoteEditor 挂载、自己的 autofocus:'end' 先跑完，这里再改写光标位置
    if (pendingFocus.value === 'title') titleInputRef.value?.focus()
    else if (typeof pendingFocus.value === 'number') bodyEditorRef.value?.focusAtLineUnit(pendingFocus.value)
    pendingFocus.value = null
    editReady.value = true   // 光标真正落定了，这时候才让卡片显形
  } else {
    spawnToolbarGhost()   // 摘掉编辑内容之前先截一份工具栏快照，让它跟下面的收起动画同时淡出
    document.removeEventListener('mousedown', onDocDown, true)
    if (prev && !closedByFinish) flushSave()
    // 预览先接住本地草稿，不等异步 PATCH 回写；下面 nextTick 测到的就是最终预览高度。
    pendingPreviewMd.value = serializeDraft()
    closedByFinish = false
    editReady.value = false
    await nextTick()   // 等预览态内容渲染出来，才能量到真实目标高度
  }

  // 展开/收回动画：编辑态是 flex:1 撑满父级，卡片高度被钉住的话编辑器只会乖乖填满这个
  // 旧高度、量不出真正想要的高度，所以先切回 auto 量一次目标高度，再原地扣回旧高度——这
  // 几步都在 nextTick 的微任务边界内完成，浏览器还没画那一帧 auto 的样子，不会闪一下；
  // offsetHeight 强制回流，让浏览器先"确认"这个旧高度，下一帧再改成目标值才会真的触发
  // 过渡（不这么做，同一帧内连续两次赋值可能被合并、直接跳到终值不播动画）。动画播完
  // 恢复 auto，不然后续内容变化（继续打字撑高、预览态点"展开"）会被钉死在这个旧 px 值上。
  if (el && startH != null) {
    cardHeight.value = 'auto'
    await nextTick()
    const endH = el.offsetHeight
    cardHeight.value = startH + 'px'
    await nextTick()
    void el.offsetHeight
    requestAnimationFrame(() => {
      cardHeight.value = endH + 'px'
      heightResetTimer = setTimeout(() => { cardHeight.value = 'auto'; heightResetTimer = null }, HEIGHT_ANIM_MS)
    })
  } else {
    cardHeight.value = 'auto'
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  if (heightResetTimer) clearTimeout(heightResetTimer)
})

/** 标题只在首行真是 `#` 标题格式时才从正文摘出来单独展示；纯正文/待办/列表开头的便签
 *  不摘任何东西——整段原样进 body 渲染，不会凭空多出一条"标题"把第一行跟其余内容分割开。
 *  titleRaw 是没套占位文案的原始值，给编辑态的标题草稿做种（title 那个"（空便签）"/
 *  "（无标题）"是只读态才该出现的占位显示，塞进输入框会变成假装用户写了这几个字）。 */
const _split = computed(() => {
  const md = displayContentMd.value
  const lines = md.split('\n')
  const ti = lines.findIndex(l => l.trim())
  if (ti < 0) return { title: '（空笔记）', titleRaw: '', body: '', isHeading: true }
  const titleLine = lines[ti].trim()
  const isHeading = /^#{1,6}\s+/.test(titleLine)
  if (!isHeading) return { title: '', titleRaw: '', body: md, isHeading: false }
  const raw = titleLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1')
  const body = lines.slice(ti + 1).join('\n').replace(/^\n+/, '')
  return { title: raw || '（无标题）', titleRaw: raw, body, isHeading: true }
})
const title     = computed(() => _split.value.title)
const isHeading = computed(() => _split.value.isHeading)
const bodyMd = computed(() => _split.value.body)
// 只读卡片的 Markdown 预览不是纯字符串拼接：代码块还要做语法高亮。把结果绑定到正文
// 内容本身，避免父级时间轴更新（例如其它日期新增便签）时为每张卡重复解析一遍。
const previewHtml = computed(() => bodyMd.value ? cachedPreviewHtml(bodyMd.value) : '')

/** 是否溢出 clamp 高度（内容/展开态变了都重测）。scrollHeight 对比要在未展开的 clamp 态量 */
async function measureClamp() {
  await nextTick()
  const el = bodyRef.value
  if (!el) return
  if (expanded.value) return   // 展开着就保持"可收起"，不重判
  clamped.value = el.scrollHeight > el.clientHeight + 2
}
/** 预览由 v-html 生成，引用的缺失状态在渲染后补到对应 chip 上。 */
async function refreshReferenceStates() {
  await nextTick()
  const refs = bodyRef.value?.querySelectorAll<HTMLElement>('.mind-ref[data-ref-type][data-ref-id]') ?? []
  await Promise.all([...refs].map(async refEl => {
    const state = await resolveMindRef(refEl.dataset.refType!, Number(refEl.dataset.refId))
    refEl.classList.toggle('mind-ref-missing', state === 'missing')
    if (state === 'missing') refEl.title = '关联对象已删除，仅保留快照'
  }))
}
onMounted(() => { measureClamp(); refreshReferenceStates() })
watch(() => props.note.contentMd, () => { expanded.value = false; measureClamp(); refreshReferenceStates() })

/** 卡上直接勾待办：点击落在预览里的 checkbox 时翻转对应任务，不进编辑态 */
function onBodyClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t instanceof HTMLInputElement && t.dataset.taskIdx !== undefined) {
    e.preventDefault()   // 视觉状态由 PATCH 成功后的数据回流驱动，别让浏览器先勾上
    // 标题只会摘掉真正的 # 标题行，待办/列表都不会被摘，body 里的序号就是完整 content 里的真实序号
    emit('toggle-task', Number(t.dataset.taskIdx))
    return
  }
  // 点引用 chip 跳对应对象（项目 Modal / 文件预览下载 / 活动编辑 Modal），不进编辑；
  // 点链接就正常跳转，也不进编辑；点其他区域进编辑，光标定到点的那一行后面
  const refEl = t.closest<HTMLElement>('.mind-ref')
  if (refEl) {
    if (refEl.classList.contains('mind-ref-missing')) return
    const refType = refEl.dataset.refType
    const refId = Number(refEl.dataset.refId)
    if (refType && Number.isFinite(refId)) openMindRef(refType, refId)
    return
  }
  if (t.closest('a')) return
  // 刚才是拖选文字（松手时还留着一段非空选区），不是想点进编辑——click 在鼠标抬起时
  // 还是会照常触发，不额外拦住的话选完文字会立刻被拽进编辑态，选区也跟着没了。
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.toString().length > 0) return
  const lineEl = t.closest<HTMLElement>('[data-line-unit]')
  startEditAt(lineEl ? Number(lineEl.dataset.lineUnit) : null)
}

// 画布便签（NoteSticker.vue）复用这个组件本体做展示/编辑，拖拽克隆需要这张卡真实的根
// DOM（不是外面包着的绝对定位壳），量高度上报给 RelationLayer 的连线锚点也是同一份——
// 跟 ProjectCard.vue/FileCard.vue 的 defineExpose({ rootEl }) 同一个用途。
defineExpose({ rootEl: cardRef })
</script>

<style scoped>
/* 便签卡：与定时任务卡/项目卡同款质感（白 56% 底 + 白描边 + 顶部高光 ::after + hover
   加深阴影），躺在每日玻璃底板之内。卡自身不用 backdrop-filter（底板已经是玻璃），
   卡内 hover/让位动画都发生在底板内容层，不碰底板的 backdrop。 */
.note-card {
  position: relative;
  padding: 11px 13px;
  min-height: 140px;   /* 卡片本身兜住方形高度，不依赖 .nc-body 是否渲染（纯标题便签也不会变扁） */
  box-sizing: border-box;
  border-radius: 14px;
  corner-shape: round;
  background: rgba(255,255,255,0.56);
  border: 1px solid rgba(255,255,255,0.72);
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  min-width: 0; overflow: hidden;
  /* height 过渡是编辑/预览切换的展开收回动画（见 script 里的 cardHeight/HEIGHT_ANIM_MS），
     缓动跟 NoteEditor 抽屉动画同一条缓入缓出曲线，不是线性、也不带回弹。
     transform 的过渡也在这里合并声明（数值抄 .hover-card-fx，见 global.css）：画布态的
     .note-card 自己另外挂了 .hover-card-fx 类给 hover 上浮动效，但它的 transition 特异度
     只是 1 个类（同 scoped 编译前的 .note-card），编译后这里带 [data-v-xxx] 属性选择器、
     特异度更高，会整个覆盖掉 .hover-card-fx 那份 transition（transition 是覆盖式属性，不是
     合并），把 transform 那部分连带吃掉，悬浮上浮会变成瞬间跳变而不是动画——EntitySticker.vue
     踩过同一个坑，解法一致：两边都要的属性在这个特异度更高的规则里合并声明一份完整的。 */
  transition: transform 0.25s cubic-bezier(0.34,1.2,0.64,1),
              box-shadow 0.3s ease, background 0.25s ease-out, height 0.19s cubic-bezier(0.65,0,0.35,1);
}
/* 顶部高光层（task-card 同款）：hover 时整层提亮 */
.note-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(to top, rgba(255,255,255,0.08), transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  transition: background 0.3s cubic-bezier(0.34,1.2,0.64,1); pointer-events: none;
}
.note-card > * { position: relative; z-index: 1; }
.note-card:not(.editing):hover { box-shadow: 0 6px 18px rgba(80,90,110,0.13); }
.note-card:not(.editing):hover::after { background: rgba(255,255,255,0.2); }

.note-card.editing { background: rgba(255,255,255,0.9); }
/* 光标还没定位到该去的地方之前（默认落点/上一次残留选区）先藏起来，不让这个过渡态被看见——
   比如正文开头是待办，进编辑态那一瞬容易先"亮"一下待办的默认焦点样式再跳到该定的位置。
   用 opacity 不用 visibility：visibility:hidden 的元素浏览器不让 focus()，我们恰恰要在
   这段隐藏期间调用 focus()/focusAtLineUnit() 把光标定过去，用 visibility 会导致这次
   focus() 直接是空操作，编辑器永远拿不到真正的焦点（工具栏 isFocused 判断就一直是 false）。
   opacity:0 不影响可聚焦性，配 pointer-events:none 防这段时间被点到。布局占位保留，
   不会引起列内卡片抖动。 */
.note-card.nc-edit-pending { opacity: 0; pointer-events: none; }
/* 编辑态整卡走 flex 列：编辑器吃满剩余高度，取消/保存永远贴在卡片底部，不会因为内容
   短、卡片够着 min-height 的地板价时，按钮悬在半截、下面空一大截。 */
.note-card.editing {
  display: flex; flex-direction: column;
}
.note-card.editing :deep(.note-editor) {
  flex: 1; display: flex; flex-direction: column; min-height: 0;
}
/* 工具栏模糊淡入：卡片本身通过 nc-edit-pending 这层 opacity 整卡显形是瞬间的（光标定位
   落定就直接显示），工具栏在此基础上单独再叠一层从模糊到清晰的过渡，让"进入编辑态"这个
   动作里工具栏看起来是单独浮出来的，不是跟标题/正文一起硬切出现。 */
.note-card.editing :deep(.ne-toolbar) {
  opacity: 0; filter: blur(6px);
  transition: opacity 0.14s ease-in-out, filter 0.14s ease-in-out;
}
.note-card.editing:not(.nc-edit-pending) :deep(.ne-toolbar) {
  opacity: 1; filter: blur(0);
}
.note-card.editing :deep(.ne-body) {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
}
.note-card.editing :deep(.ne-body .ProseMirror) {
  flex: 1; min-height: 0;
}
/* 编辑态标题区：跟只读态 .nc-title 同样字号字重，固定分割线跟正文区隔开（不管有没有
   打字都分——按区域区分，不是靠有没有内容判断）。 */
.nc-title-input {
  flex-shrink: 0; width: 100%;
  border: none; outline: none; background: none; padding: 0 0 7px; margin-bottom: 4px;
  border-bottom: 1px solid rgba(80,90,110,0.1);
  font-size: 14px; font-weight: 600; line-height: 1.35;
  color: var(--text-primary); font-family: var(--font-sans);
}
.nc-title-input::placeholder { color: var(--text-secondary); opacity: 0.5; font-weight: 400; }

/* 新建高亮：紫灰 tint 淡出（提交滚回最左后让新卡自己说"我在这") */
.note-card.highlight { animation: nc-flash 1.6s ease-out; }
@keyframes nc-flash {
  0% { background-color: rgba(123,127,178,0.2); }
  100% { background-color: rgba(255,255,255,0.56); }
}

/* 可选颜色：整卡淡染（便签纸语言），不做左侧色条（那是管理系统语言）。"Caribbean" 配色，
   亮色高饱和度（青绿/蓝/珊瑚橙/黄，见 ColorSwatches.vue 的色点原色），淡染到卡片背景上的
   透明度比色点本身低不少——原色直接铺满整卡会盖过正文文字的可读性，这里只取一层够看得出
   颜色、又不抢内容的淡染。 */
/* 颜色调过四轮：8:2 白 → 反馈"再亮一点"退到 6:4 → 反馈"再白一点"到 75:25 → 又反馈
   "再白一点淡一点"，现在定在白:色约 85:15（目前最淡的一档），色相仍跟 ColorSwatches.vue
   的色点原色一致（橙/红/蓝/青），只是掺白比例调得更柔和。 */
/* 曾经列表态用半透明 0.6 alpha 叠加淡染、画布态用同一份白:色混合比例但不透光——结果是
   同一个颜色选项在两处看起来"略微不一样"：半透明色块叠在时间流每日玻璃底板（.tl-col 的
   --glass-bg）之上，实际合成出来的颜色会被底板+页面背景那一层影响，跟画布态直接铺色的
   纯色不是同一个视觉结果。用户反馈"用便签的颜色"——这里改成跟画布态完全相同的不透明色值，
   不再区分列表态/画布态，两处颜色现在是同一份数值、同一个观感。没上色的默认笔记不受影响，
   仍然是 .note-card 基础声明的半透明纸色（rgba(255,255,255,0.56)）。 */
.note-card.tint-amber { background: rgb(255,246,231); }
.note-card.tint-coral { background: rgb(255,236,233); }
.note-card.tint-blue  { background: rgb(224,239,251); }
.note-card.tint-teal  { background: rgb(229,248,250); }

/* 画布模式：材质换成不透明的纸感（NoteSticker.vue 原来的纸色 rgba(255,252,238,.92)，
   这里再提高到接近全不透明）——只有"没上色"的默认纸色区分列表态/画布态，上面那组自定义
   颜色两边已经统一成同一份不透明数值。
   ⚠️ 但 .canvas-mode 这条 selector 是两个类（.note-card.canvas-mode），跟上面 .tint-* 也是
   两个类（.note-card.tint-amber）特异度相同——一张画布便签同时挂着 canvas-mode 和 tint-amber
   两个类时，两条规则打平，谁赢看谁在样式表里排得靠后：这条排在 .tint-* 后面，会赢，把刚选
   的颜色重新盖回纸色，画布便签的静止态（没在拖）就只会显示纸色、看不出选的颜色——只有拖起来
   那一刻的克隆体是靠 .phys-drag-clone.note-card.canvas-mode.tint-*（四个类 +!important）
   另外赢一次，才会显示颜色（"抓起来时正确、松开后又变回纸色"的根因）。这里必须补一份三个类
   的 .canvas-mode.tint-* 稳赢，不能只留这条两个类的默认纸色声明。 */
.note-card.canvas-mode { background: rgba(255,252,238,0.97); }
.note-card.canvas-mode.tint-amber { background: rgb(255,246,231); }
.note-card.canvas-mode.tint-coral { background: rgb(255,236,233); }
.note-card.canvas-mode.tint-blue  { background: rgb(224,239,251); }
.note-card.canvas-mode.tint-teal  { background: rgb(229,248,250); }
/* 画布模式下改回 visible——.note-card 平时 overflow:hidden（裁掉溢出圆角的正文/标题内容），
   但连接点（CardAffordances.vue）现在渲染在这张卡自己的子树里、圆点位置故意摆在卡片边缘外侧
   （见 CardAffordances.vue 的 .conn-dot-left/right），会被这份 hidden 整个
   裁掉一半——文件/项目引用卡本来就各自这样处理过同一个坑（FileRefCard.vue 的 :deep(.fc-card)
   /ProjectRefCard.vue 的 .pr-card 都是 overflow:visible），便签只在画布模式才需要，不影响
   笔记页时间流原有的裁剪需要。 */
.note-card.canvas-mode { overflow: visible; }

.nc-head {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 4px; position: relative; z-index: 1;
}
/* 只有正文存在时才分割——纯标题便签不该悬空挂一条线 */
.nc-head:has(+ .nc-body) {
  padding-bottom: 7px;
  border-bottom: 1px solid rgba(80,90,110,0.1);
}
/* 单行截断而不是 2 行 clamp：编辑态的标题是单行 <input>（不会换行），只读态如果允许标题
   换行到 2 行，同一条标题在两种状态下占的高度不一样，分割线的位置就会跟着挪——标题
   本来就该短，单行更符合预期，也让编辑/只读两态的几何完全对齐。 */
.nc-title {
  flex: 1; min-width: 0; cursor: text;
  font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nc-icon {
  padding: 3px; border: none; border-radius: 5px;
  background: transparent; color: var(--text-secondary); cursor: pointer;
  display: inline-flex; align-items: center;
}
.nc-icon:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.nc-icon.danger:hover { background: rgba(176,120,88,0.12); color: #b07858; }

/* min-height 让短便签也有几行留白、卡片偏方形——一行字的扁条卡在 440px 列里太寒酸；
   overflow-wrap 治连续长串（纯数字/URL）不换行撑破卡片 */
.nc-body {
  position: relative; z-index: 1; cursor: text;
  min-height: 76px;
  overflow-wrap: anywhere;
}
.nc-body.clamped {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
}
.nc-expand {
  margin-top: 4px; padding: 0; border: none; background: none;
  font-size: 11px; color: var(--color-primary); cursor: pointer;
  font-family: var(--font-sans); position: relative; z-index: 1;
}

.nc-conflict { font-size: 11px; color: #b07858; white-space: nowrap; }
/* "完成"退出编辑：点卡外面自动保存退出这个出口不够显眼（画布上尤其容易让人以为点哪都还在
   编辑器范围内），常驻在工具栏右端兜底。默认没有描边/底色，跟其它卡片的按钮同一个语言——
   平时融进工具栏，只在悬停时才提示"这是个可点的东西"。 */
.nc-done-btn {
  display: inline-flex; align-items: center; gap: 3px;
  border: none; background: none; padding: 3px 8px; border-radius: 6px;
  font-size: 11.5px; font-weight: 600; color: var(--color-primary);
  cursor: pointer; font-family: var(--font-sans); white-space: nowrap;
  transition: background 0.12s;
}
.nc-done-btn:hover { background: rgba(123,127,178,0.12); }
</style>

<!-- v-html 出来的预览内容不能 scoped；排版规则跟 NoteEditor.vue 共用同一份文件，
     两边数值必须一致，见 mind-content.css 顶部注释 -->
<style src="./mind-content.css"></style>
