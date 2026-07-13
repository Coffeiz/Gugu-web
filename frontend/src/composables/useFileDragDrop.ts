/**
 * 文件/文件夹卡片的 pointer 拖拽编排——文件库（Files/index.vue）与项目编辑卡文件面板
 * （ProjectModal.vue）共用一份，别各自抄一遍（两边选区状态、API/缓存策略不同，但"抓起判断
 * 单选/多选 → 起 startPhysicsDrag/startMultiPhysicsDrag → 拖拽中每帧找落点高亮 → 松手判定
 * 目标并派发移动"这条编排逻辑完全一样）。
 *
 * 为什么卡片拖拽必须走 pointer 模式、不能用原生 HTML5 draggable/dragstart：
 * 原生拖拽从 dragstart 起浏览器会整段暂停 mouseover/mouseout 派发，抓起卡片那一刻缓存的
 * :hover=true 全程不会被清掉，直到 dragend 后才重新判定——这段时间差会导致拖拽落地揭示
 * 卡片时出现 hover 高亮跳变（perf trace 实测证实，见 usePhysicsDrag.ts 顶部注释）。
 *
 * 两个组件的差异点都做成了配置项：卡片元素的 data 属性名、文件夹选择器（网格卡 vs 列表行两边
 * class 不同名）、面包屑每个 idx 是否可放置及能接收文件/文件夹（Files 的根「全部文件」不可
 * 放置、其余段接收文件和文件夹；ProjectModal 的根「项目文件」用 idx=-1、可放置，但所有段都
 * 只接收文件不接收文件夹——这是原生 dataTransfer 版本就有的行为差异，转 pointer 模式时原样
 * 保留，不是本次改造引入的新限制）、真正执行移动的 API 调用（Files 走乐观缓存+回滚，
 * ProjectModal 走移动后整体重新拉取，两者刷新时机还因落点是文件夹卡片还是面包屑而不同，
 * 见 moveFolders/moveFiles 的 dropInfo 参数）。
 */
import { ref, type Ref } from 'vue'
import { startMultiPhysicsDrag, startPhysicsDrag, startThresholdDrag } from './usePhysicsDrag'

type Id = number | string

export interface BcDropTarget {
  targetFolderId: Id | null
  acceptsFiles: boolean
  acceptsFolders: boolean
}

export interface FileDragDropConfig {
  fileDataAttr: string          // 卡片元素上标文件 id 的 data 属性名，如 'data-file-id'
  // 卡片元素上标"真实数字 folderId"的 data 属性名——注意别跟框选/选择态用的 key 属性（可能是带
  // 前缀的字符串，如 Files 的 data-folder-key="f:65"）搞混，这里必须是能 Number() 出真实 id 的那个
  // （踩过一次：两者共用一个属性，Number("f:65") 是 NaN，导致所有文件夹拖拽落点都判定失败）。
  folderDataAttr: string
  folderSelector: string        // 文件夹卡片/行的选择器，如 '.folder-card, .folder-row'
  bcSelector?: string           // 面包屑段选择器，默认 '.bc-item'
  bcIdxAttr?: string            // 面包屑段标索引的 data 属性名，默认 'data-bc-idx'
  // 面包屑某个 idx 能不能接收拖拽、接收后目标文件夹 id 是什么；idx 是从 DOM 属性读到的值
  // （原样传入，Files 侧永远是 >=0 的数字，ProjectModal 侧根节点是 -1）。返回 null 表示
  // 这个 idx 不是有效放置目标。
  resolveBcTarget: (idx: number) => BcDropTarget | null
  cancelBoxDrag: () => void
  clearSelection: () => void
  // dropInfo.droppedOn 告知落在文件夹卡片还是面包屑段上——两边刷新策略不同时用（Files 两者都走
  // 乐观缓存，用不上；ProjectModal 落文件夹卡片整体重新拉取+重置导航，落面包屑只轻量刷新当前层）
  moveFolders: (folderIds: Id[], targetFolderId: Id | null, dropInfo: { droppedOn: 'folder' | 'breadcrumb' }) => Promise<void>
  moveFiles: (fileIds: Id[], targetFolderId: Id | null, dropInfo: { droppedOn: 'folder' | 'breadcrumb' }) => Promise<void>
}

export interface CardDragCtx {
  itemId: Id
  isFolder: boolean
  isSelected: boolean             // 这张卡此刻是否处于选中态（决定单选/带选区一起拖）
  selectedFileIds: Set<Id>
  selectedFolderIds: Set<Id>
  extraOpts?: Record<string, any> // 透传给 startPhysicsDrag/startMultiPhysicsDrag 的额外 opts（如 cloneClass）
}

export function useFileDragDrop(config: FileDragDropConfig) {
  const bcSelector = config.bcSelector ?? '.bc-item'
  const bcIdxAttr  = config.bcIdxAttr ?? 'data-bc-idx'

  const draggingFileIds   = ref(new Set<Id>())
  const draggingFolderIds = ref(new Set<Id>())
  const dragOverFolderId  = ref<Id | null>(null)
  const bcDragOverIdx     = ref<number | null>(null)

  // dispatchDrop 落地一开始就把 draggingFileIds/draggingFolderIds 清空（让卡片立刻退出"拖拽中"
  // 视觉态，不等异步移动结束）。但 resolveAbsorbTarget 是 usePhysicsDrag 在那之后才调用的（落点
  // 判定用），dispatchDrop 自己的面包屑分支也在清空之后才跑——两处如果直接读 draggingFileIds.value
  // 就永远看到空集合，_acceptable 恒为 false（面包屑目标显示高亮正常、真松手却"没反应"，就是
  // 这个时序坑）。留一份不随之清空的快照，专给这两处收尾逻辑用。
  let _dragSnapshot: { fileIds: Set<Id>; folderIds: Set<Id> } = { fileIds: new Set(), folderIds: new Set() }

  function _bcIdx(el: Element | null): number | null {
    if (!el?.hasAttribute?.(bcIdxAttr)) return null
    return Number(el.getAttribute(bcIdxAttr))
  }
  function _acceptable(target: BcDropTarget | null, hasFiles: boolean, hasFolders: boolean): boolean {
    if (!target) return false
    return (hasFiles && target.acceptsFiles) || (hasFolders && target.acceptsFolders)
  }

  // 拖拽过程中每帧回调：找当前指针下是否压着有效放置目标，更新高亮（不能拖到自身）
  function updateDragOverHighlight({ x, y }: { x: number; y: number }) {
    if (!draggingFileIds.value.size && !draggingFolderIds.value.size) {
      dragOverFolderId.value = null; bcDragOverIdx.value = null
      return
    }
    const under = document.elementFromPoint(x, y)
    const folderEl = under?.closest?.(config.folderSelector)
    if (folderEl) {
      const key = Number(folderEl.getAttribute(config.folderDataAttr))
      dragOverFolderId.value = draggingFolderIds.value.has(key) ? null : key
      bcDragOverIdx.value = null
      return
    }
    const idx = _bcIdx(under?.closest?.(bcSelector) ?? null)
    if (idx !== null && _acceptable(config.resolveBcTarget(idx), draggingFileIds.value.size > 0, draggingFolderIds.value.size > 0)) {
      bcDragOverIdx.value = idx
      dragOverFolderId.value = null
      return
    }
    dragOverFolderId.value = null
    bcDragOverIdx.value = null
  }

  // 「吸入文件夹/面包屑」缩小消失动画的目标判定，喂给 startPhysicsDrag/startMultiPhysicsDrag
  // 的 resolveAbsorbTarget——跟 updateDragOverHighlight/dispatchDrop 用同一套有效性判断，
  // 避免数据层判定"不动"、视觉层却演了一遍"吸入消失"，两边对不上。这个回调在 dispatchDrop 清空
  // draggingFileIds/draggingFolderIds 之后才会跑，所以用 _dragSnapshot，不用那两个活引用。
  function resolveAbsorbTarget(under: Element): Element | null {
    const folderEl = under?.closest?.(config.folderSelector)
    if (folderEl) {
      const key = Number(folderEl.getAttribute(config.folderDataAttr))
      return _dragSnapshot.folderIds.has(key) ? null : folderEl
    }
    const bcEl = under?.closest?.(bcSelector) ?? null
    const idx = _bcIdx(bcEl)
    if (idx !== null && _acceptable(config.resolveBcTarget(idx), _dragSnapshot.fileIds.size > 0, _dragSnapshot.folderIds.size > 0)) return bcEl
    return null
  }

  // 松手落点判定 + 真正执行移动（startPhysicsDrag/startMultiPhysicsDrag 的 onDrop 回调）。
  // 命中判定必须用 context.pointer（原始指针位置），不能用第一个参数 pos（克隆体视觉中心）——
  // usePhysicsDrag 内部「吸入文件夹/面包屑」的动画判定已经改成了指针位置（见其 end() 注释：
  // 卡片抓取点偏卡片上部、卡片本身比面包屑这类细长目标高得多，视觉中心会跟指针差出小半个卡
  // 高，面包屑这种窄条正好被跨过去）。这里若仍用 pos，会出现「动画演了吸入面包屑、实际这个
  // 函数里的命中判定却落空」——动画和数据两套判定不一致，看着像吸入了，刷新后其实没动。
  async function dispatchDrop(pos: { x: number; y: number }, _vel?: unknown, _size?: unknown, context?: { pointer: { x: number; y: number } }) {
    const { x, y } = context?.pointer ?? pos
    const under = document.elementFromPoint(x, y)
    dragOverFolderId.value = null
    bcDragOverIdx.value = null

    let draggedFolderIds = [...draggingFolderIds.value]
    let draggedFileIds   = [...draggingFileIds.value]
    draggingFolderIds.value = new Set()
    draggingFileIds.value   = new Set()
    if (!draggedFolderIds.length && !draggedFileIds.length) return

    let targetFolderId: Id | null = null
    let droppedOn: 'folder' | 'breadcrumb' = 'folder'
    const folderEl = under?.closest?.(config.folderSelector)
    if (folderEl) {
      const key = Number(folderEl.getAttribute(config.folderDataAttr))
      if (draggedFolderIds.includes(key)) return   // 拖到自己身上，不动
      targetFolderId = key
    } else {
      const idx = _bcIdx(under?.closest?.(bcSelector) ?? null)
      if (idx === null) return
      const target = config.resolveBcTarget(idx)
      if (!target || !_acceptable(target, draggedFileIds.length > 0, draggedFolderIds.length > 0)) return
      targetFolderId = target.targetFolderId
      droppedOn = 'breadcrumb'
      if (!target.acceptsFolders) draggedFolderIds = []
      if (!target.acceptsFiles) draggedFileIds = []
      if (!draggedFolderIds.length && !draggedFileIds.length) return
    }

    config.clearSelection()
    if (draggedFolderIds.length) await config.moveFolders(draggedFolderIds, targetFolderId, { droppedOn })
    if (draggedFileIds.length) await config.moveFiles(draggedFileIds, targetFolderId, { droppedOn })
  }

  // pointerdown 起，越过 5px 阈值才真正开拖（否则当普通点击，交给原有 @click 处理）；内部操作
  // 按钮/重命名输入框先排除——原生 draggable 版本靠子元素 @mousedown.prevent 挡掉 dragstart，
  // pointerdown 没有等价的天然阻挡，这里手动排除。阈值判定本身收在 usePhysicsDrag.ts 的
  // startThresholdDrag（跟 ProjectCard.vue 共用同一份，不再各写一遍）。
  function _startCardDrag(e: PointerEvent, ctx: CardDragCtx) {
    startThresholdDrag(e, {
      exclude: t => !!(t as Element)?.closest?.('button, input, .rename-sizer'),
      onBeforeDragStart: () => config.cancelBoxDrag(),
      onDragStart: (ev, card) => {
        const isMulti = ctx.isSelected && (ctx.isFolder ? ctx.selectedFolderIds.size > 0 : ctx.selectedFileIds.size > 0)
        let folderIds: Id[], fileIds: Id[]
        if (ctx.isFolder) {
          folderIds = isMulti ? [...ctx.selectedFolderIds] : [ctx.itemId]
          fileIds   = isMulti ? [...ctx.selectedFileIds] : []
        } else {
          fileIds   = isMulti ? [...ctx.selectedFileIds] : [ctx.itemId]
          folderIds = isMulti ? [...ctx.selectedFolderIds] : []
        }

        draggingFolderIds.value = new Set(folderIds)
        draggingFileIds.value   = new Set(fileIds)
        _dragSnapshot = { fileIds: new Set(fileIds), folderIds: new Set(folderIds) }

        // 文件名和元信息是高频阅读内容；后仰会把整张卡送进 3D 合成层，让细字变软。
        // 保留弹簧、平面摆动和阴影，只关闭这条不利于文字清晰度的变换。
        const opts = { pointer: true, tilt: 0, onDrop: dispatchDrop, onDragOver: updateDragOverHighlight, resolveAbsorbTarget, ...(ctx.extraOpts || {}) }
        const total = folderIds.length + fileIds.length
        if (total > 1) {
          const extraFolderEls = folderIds.filter(id => id !== (ctx.isFolder ? ctx.itemId : undefined))
            .map(item => document.querySelector(`[${config.folderDataAttr}="${item}"]`)).filter(Boolean) as HTMLElement[]
          const extraFileEls = fileIds.filter(id => id !== (!ctx.isFolder ? ctx.itemId : undefined))
            .map(id => document.querySelector(`[${config.fileDataAttr}="${id}"]`)).filter(Boolean) as HTMLElement[]
          const extras = ctx.isFolder ? [...extraFolderEls, ...extraFileEls].slice(0, 2) : [...extraFileEls, ...extraFolderEls].slice(0, 2)
          startMultiPhysicsDrag(ev, card, total, extras, opts)
        } else {
          startPhysicsDrag(ev, card, opts)
        }
      },
    })
  }

  return {
    draggingFileIds, draggingFolderIds, dragOverFolderId, bcDragOverIdx,
    updateDragOverHighlight, resolveAbsorbTarget, dispatchDrop,
    onFolderPointerDown: (e: PointerEvent, ctx: Omit<CardDragCtx, 'isFolder'>) => _startCardDrag(e, { ...ctx, isFolder: true }),
    onFilePointerDown:   (e: PointerEvent, ctx: Omit<CardDragCtx, 'isFolder'>) => _startCardDrag(e, { ...ctx, isFolder: false }),
  }
}
