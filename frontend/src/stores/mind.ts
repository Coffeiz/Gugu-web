/**
 * 思维面板 store（P1：只管「笔记」这一半）。
 *
 * 时间流按 capturedAt 倒序——补录昨天的想法要落回它「发生」的那天，不能因为刚写就排最前，
 * 所以本地插入/改动后一律重排，不假设「新写的就在最前面」。
 *
 * 便签更新走乐观锁：请求带 version，后端版本对不上回 409。这里把 409 单独抛成
 * `MindConflictError`，调用方（编辑器）据此提示「已被其他端修改」并重新拉取。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  mindApi, type MindCanvas, type MindCanvasItem, type MindCanvasNoteCreate, type MindNote, type MindNoteCreate,
  type MindNoteUpdate, type MindRelation,
} from '@/services/api'
import { localDayKey, parseUtc } from '@/utils/dateAttribution'
import type { RelationAnchorSides } from '@/composables/useMindCanvas'
import { useLiveStore } from '@/stores/live'
import type { LiveEventPayload } from '@/types/live-events'
import { isMindLandingActive, onMindLandingSettled } from '@/interaction/runtime/canvas'

export class MindConflictError extends Error {
  constructor() { super('便签已被其他端修改') }
}

/** 按 capturedAt 倒序；同一时刻用 id 兜底，保证顺序稳定不抖 */
function byCapturedDesc(a: MindNote, b: MindNote): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1
  return b.id - a.id
}

/** 引用锚点 `[[project:7|某项目]]` 只留显示名，给前端筛选当纯文本用 */
function plainOf(md: string): string {
  return md.replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1')
}

/** API 列表是关系实体的边界；同一 id 只允许进入前端一次，避免 SVG TransitionGroup 收到重复 key。 */
export function normalizeCanvasRelations(relations: MindRelation[]): MindRelation[] {
  const seen = new Set<number>()
  return relations.filter(relation => {
    if (seen.has(relation.id)) return false
    seen.add(relation.id)
    return true
  })
}

let optimisticSeq = 0
let optimisticRelationSeq = 0

export const useMindStore = defineStore('mind', () => {
  const notes   = ref<MindNote[]>([])
  const loading = ref(false)
  const loaded  = ref(false)
  const loadingMore = ref(false)
  const hasMore = ref(true)
  const filterQ = ref('')   // 胶囊条的便签筛选（客户端过滤已加载的便签）
  const jumpTarget = ref('')   // 顶部日历选中的日期：跨 index.vue/NotesView.vue 传递跳转意图
  const canvases = ref<MindCanvas[]>([])
  const canvasesLoaded = ref(false)
  const canvasLoading = ref(false)
  const activeCanvasId = ref<number | null>(null)
  const canvasItems = ref<MindCanvasItem[]>([])
  const canvasRelations = ref<MindRelation[]>([])
  let canvasLoadSeq = 0
  const pendingCanvasLoads = new Map<number, number>()
  const invalidatedCanvasLoads = new Set<number>()
  const canvasDataSaves = new Map<number, Promise<void>>()
  const canvasZSaves = new Map<number, Promise<void>>()
  // 抽屉→画布先创建负 id placeholder。regrab 可能发生在 createRefNode/addCanvasItem 完成前，
  // 此时不能拿负 id 调后端；只保留前端最新位置/取消意图，等真实 item id 到手后一次性交接。
  const pendingProjectRefCreates = new Map<number, { clientKey: string; cancelled: boolean }>()
  let pendingMindRefresh = false

  function refreshMindFromLiveEvent() {
    if (!loaded.value) return
    fetchNotes()
    if (canvasesLoaded.value) fetchCanvases()
    if (activeCanvasId.value != null) loadCanvas(activeCanvasId.value)
  }

  function requestMindRefresh() {
    if (isMindLandingActive()) {
      pendingMindRefresh = true
      return
    }
    refreshMindFromLiveEvent()
  }

  onMindLandingSettled(() => {
    if (!pendingMindRefresh) return
    pendingMindRefresh = false
    refreshMindFromLiveEvent()
  })

  /** 时间流：按 capturedAt 分组成「一天一组」，供 NoteTimeline 渲染；筛选词命中正文才留 */
  const timeline = computed(() => {
    const q = filterQ.value.trim().toLowerCase()
    const pool = q
      ? notes.value.filter(n => plainOf(n.contentMd).toLowerCase().includes(q))
      : notes.value
    const groups: { date: string; items: MindNote[] }[] = []
    // notes 始终由 store 按 capturedAt 保持有序；筛选只过滤，不再为每次输入复制并排序整份列表。
    for (const n of pool) {
      const date = localDayKey(parseUtc(n.capturedAt))   // 按用户本地日分组（不是 UTC 日，否则跨午夜错一天）
      const last = groups[groups.length - 1]
      if (last && last.date === date) last.items.push(n)
      else groups.push({ date, items: [n] })
    }
    return groups
  })

  const NOTE_PAGE_SIZE = 100

  async function fetchNotes() {
    loading.value = true
    try {
      const firstPage = await mindApi.listNotes(NOTE_PAGE_SIZE, 0)
      notes.value = firstPage
      hasMore.value = firstPage.length === NOTE_PAGE_SIZE
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 时间轴向左（更早日期）滚动到边缘时追加下一页，已加载的卡片不重建。 */
  async function loadMoreNotes() {
    if (!loaded.value || loading.value || loadingMore.value || !hasMore.value) return
    loadingMore.value = true
    try {
      const page = await mindApi.listNotes(NOTE_PAGE_SIZE, notes.value.length)
      const known = new Set(notes.value.map(note => note.id))
      const appended = page.filter(note => !known.has(note.id))
      if (appended.length) notes.value = [...notes.value, ...appended].sort(byCapturedDesc)
      hasMore.value = page.length === NOTE_PAGE_SIZE
    } finally {
      loadingMore.value = false
    }
  }

  async function createNote(data: MindNoteCreate): Promise<MindNote> {
    const created = await mindApi.createNote(data)
    notes.value = [created, ...notes.value].sort(byCapturedDesc)
    return created
  }

  async function updateNote(id: number, data: MindNoteUpdate): Promise<MindNote> {
    // 乐观更新：改动先立刻摆进本地列表用于显示，不等网络往返——不然编辑完一关卡片，
    // 只读态会先用回旧内容闪一下、等 PATCH 落地才变新内容，观感上不像"乐观保存"。
    // 特意不碰 version：那是下一次乐观锁请求要带的值，得等服务端真的确认过才能往前挪，
    // 否则两次编辑离得很近时，后一次会拿着"还没被服务端确认过"的 version 去比对，
    // 平白撞出本不该有的 409（对不齐锁版本 ≠ 真的有冲突）。
    const optimisticIdx = notes.value.findIndex(n => n.id === id)
    if (optimisticIdx !== -1) notes.value[optimisticIdx] = { ...notes.value[optimisticIdx], ...data }

    let updated: MindNote
    try {
      updated = await mindApi.updateNote(id, data)
    } catch (e: any) {
      if (e?.status === 409) throw new MindConflictError()
      throw e
    }
    const i = notes.value.findIndex(n => n.id === id)
    if (i !== -1) notes.value[i] = updated
    notes.value = [...notes.value].sort(byCapturedDesc)   // capturedAt 可能被改过
    return updated
  }

  /** 软删：后端只写 deleted_at（墓碑），这里从列表里摘掉即可 */
  async function deleteNote(id: number) {
    await mindApi.deleteNote(id)
    notes.value = notes.value.filter(n => n.id !== id)
  }

  async function fetchCanvases() {
    canvasLoading.value = true
    try {
      canvases.value = await mindApi.listCanvases()
      canvasesLoaded.value = true
    } finally {
      canvasLoading.value = false
    }
  }

  async function createCanvas(title = '未命名画布') {
    const canvas = await mindApi.createCanvas({ title })
    canvases.value = [canvas, ...canvases.value]
    return canvas
  }

  async function renameCanvas(id: number, title: string) {
    const updated = await mindApi.updateCanvas(id, { title })
    const index = canvases.value.findIndex(canvas => canvas.id === id)
    if (index !== -1) canvases.value[index] = updated
    return updated
  }

  async function deleteCanvas(id: number) {
    // 删除请求一发出就让该画布的 pending load 失效，避免「open → delete → load response」
    // 的旧响应把已经从列表移除的画布重新写成 active。
    invalidatedCanvasLoads.add(id)
    pendingCanvasLoads.delete(id)
    try {
      await mindApi.deleteCanvas(id)
    } catch (error) {
      invalidatedCanvasLoads.delete(id)
      throw error
    }
    canvases.value = canvases.value.filter(canvas => canvas.id !== id)
    // 删的正好是当前打开这张——清空本地视图状态，CanvasView.vue 的 ensureCanvas() 会在
    // 路由跳到别的画布 id 后自然重新 loadCanvas；这里不主动切换，留给调用方决定切去哪张
    // （比如优先切到列表里剩下的第一张，没有了就新建一张）。
    if (activeCanvasId.value === id) {
      activeCanvasId.value = null
      canvasItems.value = []
      canvasRelations.value = []
    }
  }

  async function loadCanvas(id: number) {
    const requestSeq = ++canvasLoadSeq
    pendingCanvasLoads.set(id, requestSeq)
    try {
      const [items, relations] = await Promise.all([
        mindApi.listCanvasItems(id),
        mindApi.listCanvasRelations(id),
      ])
      const isCurrentRequest = pendingCanvasLoads.get(id) === requestSeq
      const stillExists = canvases.value.some(canvas => canvas.id === id)
      if (!isCurrentRequest || requestSeq !== canvasLoadSeq || invalidatedCanvasLoads.has(id) || !stillExists) return false
      activeCanvasId.value = id
      canvasItems.value = normalizeCanvasZ(items).map(({ item, z }) => ({ ...item, z }))
      canvasRelations.value = normalizeCanvasRelations(relations)
      return true
    } finally {
      if (pendingCanvasLoads.get(id) === requestSeq) pendingCanvasLoads.delete(id)
    }
  }

  async function addNoteToCanvas(canvasId: number, note: MindNote, x: number, y: number) {
    const item = await mindApi.addCanvasItem(canvasId, { nodeId: note.id, x, y, z: nextCanvasZ() })
    const index = canvasItems.value.findIndex(current => current.id === item.id)
    if (index === -1) canvasItems.value.push(item)
    else canvasItems.value[index] = item
    return item
  }

  async function addRefToCanvas(canvasId: number, refType: 'project' | 'file' | 'event', refId: number, x: number, y: number) {
    const node = await mindApi.createRefNode(refType, refId)
    const item = await mindApi.addCanvasItem(canvasId, { nodeId: node.id, x, y, z: nextCanvasZ() })
    const index = canvasItems.value.findIndex(current => current.id === item.id)
    if (index === -1) canvasItems.value.push(item)
    else canvasItems.value[index] = item
    return item
  }

  /** 抽屉拖项目进画布专用：先本地插入一张占位卡，换取拖拽落地动画立刻有真实 DOM 可交接。
   * regrab 发生在首次落库完成前时，placeholder 继续承载最新坐标；拿到真实 id 后再把最新位置
   * 一次性 flush 到服务端。clientKey 全程不变，Runtime/Vue 都不会因 temp→real 身份切换重挂载。 */
  function addProjectRefOptimistic(canvasId: number, projectId: number, x: number, y: number) {
    const tempId = --optimisticSeq
    const clientKey = `optimistic-${tempId}`
    const now = new Date().toISOString()
    const z = nextCanvasZ()
    const placeholder: MindCanvasItem = {
      id: tempId,
      clientKey,
      canvasId,
      nodeId: tempId,
      x, y, w: null, h: null, z,
      collapsed: false,
      data: {},
      node: {
        id: tempId, kind: 'ref', title: null, contentMd: '', color: null,
        capturedAt: now, version: 0, createdAt: now, updatedAt: now,
        refType: 'project', refId: projectId,
      },
      createdAt: now, updatedAt: now,
    }
    pendingProjectRefCreates.set(tempId, { clientKey, cancelled: false })
    canvasItems.value.push(placeholder)

    const ready = (async () => {
      let persistedItemId: number | null = null
      try {
        const node = await mindApi.createRefNode('project', projectId)
        const created = await mindApi.addCanvasItem(canvasId, { nodeId: node.id, x, y, z })
        persistedItemId = created.id
        let resolved: MindCanvasItem = { ...created, clientKey }
        let persistedX = created.x
        let persistedY = created.y

        // create 返回后仍可能连续 regrab。每次网络 flush 完都重新读取 placeholder 的最新
        // 坐标；只有服务端位置追上当前乐观位置才结束，不能把“只支持一次 regrab”写进时序假设。
        while (true) {
          const pending = pendingProjectRefCreates.get(tempId)
          const currentIndex = canvasItems.value.findIndex(current => current.clientKey === clientKey)
          if (!pending || pending.cancelled || currentIndex === -1) {
            await mindApi.removeCanvasItem(canvasId, created.id)
            pendingProjectRefCreates.delete(tempId)
            return resolved
          }
          const current = canvasItems.value[currentIndex]
          if (current.x === persistedX && current.y === persistedY) break
          const targetX = current.x
          const targetY = current.y
          const moved = await mindApi.bringCanvasItemToFront(canvasId, created.id, { x: targetX, y: targetY })
          resolved = { ...moved, clientKey }
          persistedX = targetX
          persistedY = targetY
        }

        const latestPending = pendingProjectRefCreates.get(tempId)
        const latestIndex = canvasItems.value.findIndex(item => item.clientKey === clientKey)
        if (!latestPending || latestPending.cancelled || latestIndex === -1) {
          await mindApi.removeCanvasItem(canvasId, created.id)
          pendingProjectRefCreates.delete(tempId)
          return resolved
        }
        canvasItems.value[latestIndex] = resolved
        pendingProjectRefCreates.delete(tempId)
        return resolved
      } catch (error) {
        const index = canvasItems.value.findIndex(current => current.clientKey === clientKey)
        if (index !== -1) canvasItems.value.splice(index, 1)
        pendingProjectRefCreates.delete(tempId)
        // 创建已成功但后续最新位置 flush 失败时，不能在服务端留下一个本地已撤掉的孤儿卡。
        if (persistedItemId != null) await mindApi.removeCanvasItem(canvasId, persistedItemId).catch(() => {})
        throw error
      }
    })()

    return { item: placeholder, ready }
  }

  async function createCanvasNote(canvasId: number, data: MindCanvasNoteCreate) {
    const item = await mindApi.createCanvasNote(canvasId, { ...data, z: nextCanvasZ() })
    canvasItems.value.push(item)
    return item
  }

  async function updateCanvasNote(nodeId: number, fields: { title?: string; contentMd?: string; color?: string | null }) {
    const item = canvasItems.value.find(current => current.nodeId === nodeId)
    if (!item) return

    // 乐观更新：先把 fields 合并进 item.node，UI 立刻变。fields 不含 version 字段，
    // spread 合并天然不会挪 version——等 PATCH 成功再用返回值（含递增 version）整体替换，
    // 跟 updateNote 同一套策略。这样画布便签改色 / 改正文能秒级响应，不再等 100-300ms
    // 网络往返才生效（跟纯笔记路径 NotesView 一致）。
    item.node = { ...item.node, ...fields }

    let updated: MindNote
    try {
      updated = await mindApi.updateCanvasNote(nodeId, { ...fields, version: item.node.version })
    } catch (e: any) {
      // 跟 updateNote 同一套乐观锁 409 处理（见其注释）——画布便签也是同一份 MindNode，
      // 理论上一样可能撞并发编辑。
      if (e?.status === 409) throw new MindConflictError()
      throw e
    }
    item.node = updated
    return updated
  }

  function normalizeCanvasZ(items: MindCanvasItem[]) {
    return items.map((item, index) => ({ item, z: (index + 1) * 1000 }))
  }

  function nextCanvasZ() {
    return (canvasItems.value.length + 1) * 1000
  }

  async function bringCanvasItemToFront(itemId: number, x: number, y: number) {
    const canvasId = activeCanvasId.value
    if (canvasId == null) return
    const before = canvasItems.value
    const ordered = normalizeCanvasZ(before)
    const target = ordered.find(entry => entry.item.id === itemId)
    if (!target) return
    const reordered = ordered
      .filter(entry => entry.item.id !== itemId)
      .concat({ item: target.item, z: ordered.length })
    canvasItems.value = reordered.map(({ item, z }) => ({
      ...item,
      x: item.id === itemId ? x : item.x,
      y: item.id === itemId ? y : item.y,
      z,
    }))
    // 抽屉 placeholder 还没有服务端 id。regrab 的位置已同步写入本地，等首次 create 返回
    // 真实 id 后 addProjectRefOptimistic 会读取这里的最新 x/y 再 flush；禁止把负 id 发给 API。
    if (pendingProjectRefCreates.has(itemId)) return

    const previous = canvasZSaves.get(canvasId) ?? Promise.resolve()
    const save = previous.catch(() => undefined).then(async () => {
      try {
        const updated = await mindApi.bringCanvasItemToFront(canvasId, itemId, { x, y })
        const currentIndex = canvasItems.value.findIndex(item => item.id === itemId)
        if (currentIndex !== -1) {
          canvasItems.value = normalizeCanvasZ(canvasItems.value)
            .map(({ item, z }) => ({
              ...item,
              z,
              ...(item.id === itemId ? { ...updated, clientKey: item.clientKey } : {}),
            }))
        }
      } catch (error) {
        // 后续拖拽可能已经产生了更新，不能用旧快照覆盖更新后的本地状态。
        if (canvasZSaves.get(canvasId) === save) canvasItems.value = before
        throw error
      }
    })
    canvasZSaves.set(canvasId, save)
    try {
      await save
    } finally {
      if (canvasZSaves.get(canvasId) === save) canvasZSaves.delete(canvasId)
    }
  }

  async function updateCanvasItem(itemId: number, fields: Partial<Pick<MindCanvasItem, 'x' | 'y' | 'w' | 'h' | 'z' | 'collapsed' | 'data'>>) {
    const canvasId = activeCanvasId.value
    const index = canvasItems.value.findIndex(item => item.id === itemId)
    if (canvasId == null || index === -1) return
    const before = canvasItems.value[index]
    canvasItems.value[index] = { ...before, ...fields }
    try {
      const updated = await mindApi.updateCanvasItem(canvasId, itemId, fields)
      const currentIndex = canvasItems.value.findIndex(item => item.id === itemId)
      if (currentIndex !== -1) {
        // 抽屉来源的乐观节点以 clientKey 作为 Vue 的稳定身份。首次落库后若把服务端响应
        // 直接整体替换，会丢掉这个仅前端存在的字段，key 从 clientKey 突然切到真实 id，
        // 正在播的第二次拖拽落地动画便会重挂载、瞬移到最终本体位置。
        canvasItems.value[currentIndex] = {
          ...updated,
          clientKey: canvasItems.value[currentIndex].clientKey,
        }
      }
    } catch (error) {
      const currentIndex = canvasItems.value.findIndex(item => item.id === itemId)
      if (currentIndex !== -1) canvasItems.value[currentIndex] = before
      throw error
    }
  }

  async function removeCanvasItem(itemId: number) {
    const canvasId = activeCanvasId.value
    if (canvasId == null) return
    await mindApi.removeCanvasItem(canvasId, itemId)
    canvasItems.value = canvasItems.value.filter(item => item.id !== itemId)
    const nodeIds = new Set(canvasItems.value.map(item => item.nodeId))
    canvasRelations.value = canvasRelations.value.filter(rel => nodeIds.has(rel.srcNodeId) && nodeIds.has(rel.dstNodeId))
  }

  /** 从画布拖回抽屉：先摘本地展示项让物理克隆能吸入抽屉，删除失败再把原项和关系原样放回。 */
  function returnCanvasItemToDrawer(itemId: number) {
    const canvasId = activeCanvasId.value
    const index = canvasItems.value.findIndex(item => item.id === itemId)
    if (canvasId == null || index === -1) return Promise.resolve()
    const item = canvasItems.value[index]
    const relations = canvasRelations.value
    const pending = pendingProjectRefCreates.get(itemId)
    if (pending) pending.cancelled = true
    canvasItems.value.splice(index, 1)
    const nodeIds = new Set(canvasItems.value.map(current => current.nodeId))
    canvasRelations.value = canvasRelations.value.filter(rel => nodeIds.has(rel.srcNodeId) && nodeIds.has(rel.dstNodeId))
    // 首次 drawer→canvas 仍在落库时 regrab 回抽屉：本地移除就是最新乐观状态，不能向 API
    // 发送负 id。pending create 若随后拿到真实 id，会负责补偿删除那个真实 item。
    if (pending) return Promise.resolve()
    return mindApi.removeCanvasItem(canvasId, itemId).catch(error => {
      window.setTimeout(() => {
        if (activeCanvasId.value !== canvasId || canvasItems.value.some(current => current.id === item.id)) return
        canvasItems.value.splice(Math.min(index, canvasItems.value.length), 0, item)
        canvasRelations.value = relations
      }, 700)
      throw error
    })
  }

  async function createCanvasRelation(srcNodeId: number, dstNodeId: number, allowParallel = false) {
    const relation = await mindApi.createRelation(srcNodeId, dstNodeId, allowParallel)
    if (!canvasRelations.value.some(current => current.id === relation.id)) canvasRelations.value.push(relation)
    return relation
  }

  function addOptimisticCanvasRelation(srcNodeId: number, dstNodeId: number): MindRelation {
    const now = new Date().toISOString()
    const relation: MindRelation = {
      id: -(++optimisticRelationSeq),
      srcNodeId,
      dstNodeId,
      relType: 'related',
      origin: 'user',
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    }
    canvasRelations.value.push(relation)
    return relation
  }

  function replaceOptimisticCanvasRelation(optimisticId: number, relation: MindRelation): void {
    canvasRelations.value = canvasRelations.value.filter(current => current.id !== optimisticId)
    if (!canvasRelations.value.some(current => current.id === relation.id)) canvasRelations.value.push(relation)
  }

  function rollbackOptimisticCanvasRelation(id: number): void {
    canvasRelations.value = canvasRelations.value.filter(relation => relation.id !== id)
  }

  async function removeCanvasRelation(id: number) {
    await mindApi.deleteRelation(id)
    canvasRelations.value = canvasRelations.value.filter(relation => relation.id !== id)
  }

  /** 画布的视图状态共用 data_json：每次只合并自己负责的键，不能让延迟保存的相机位置覆盖
   *  已冻结的关系锚点。 */
  async function updateCanvasData(id: number, patch: Record<string, unknown>) {
    const index = canvases.value.findIndex(canvas => canvas.id === id)
    if (index === -1) return
    const current = canvases.value[index]
    // 先写本地，连续的视角/关系保存都会基于最新快照合并，不会彼此丢字段。
    canvases.value[index] = { ...current, data: { ...current.data, ...patch } }
    const previous = canvasDataSaves.get(id) ?? Promise.resolve()
    const save = previous.catch(() => {}).then(async () => {
      const latestIndex = canvases.value.findIndex(canvas => canvas.id === id)
      if (latestIndex === -1) return
      // 取队列执行时的完整快照：延迟的相机保存和刚建关系的锚点无论谁先发起，最后写出的
      // 都含有两者，不会出现旧请求后到而把 relationAnchors 冲掉。
      const latest = canvases.value[latestIndex]
      const updated = await mindApi.updateCanvas(id, { data: latest.data })
      const currentIndex = canvases.value.findIndex(canvas => canvas.id === id)
      if (currentIndex !== -1) canvases.value[currentIndex] = { ...updated, data: canvases.value[currentIndex].data }
    })
    canvasDataSaves.set(id, save)
    try {
      await save
    } finally {
      if (canvasDataSaves.get(id) === save) canvasDataSaves.delete(id)
    }
  }

  /** 记住这张画布上次的平移/缩放，下次打开时回到用户离开时的视角。 */
  async function saveCanvasView(id: number, view: { x: number; y: number; scale: number; viewport?: { width: number; height: number } }) {
    await updateCanvasData(id, view)
  }

  async function saveCanvasRelationAnchors(id: number, anchors: Record<string, RelationAnchorSides>) {
    await updateCanvasData(id, { relationAnchors: anchors })
  }

  // 实时：咕咕/IM 改了便签 → 时间流列表刷新；当前打开的画布也重拉，卡片上的笔记正文才能跟着更新
  // （画布卡片渲染的是 loadCanvas 拉回来的快照，不是 notes 数组本身，两处都要刷）。
  // 画布列表也需要同步——跨标签页创建/删除画布后，抽屉列表才能实时反映最新状态。
  const live = useLiveStore()
  function applyCanonicalEvent(event: LiveEventPayload): boolean {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, any> : null
    const kind = payload?.kind
    const value = payload?.entity ?? payload
    if (!value || typeof value !== 'object') return false
    if (kind === 'note') {
      const note = value as MindNote
      const index = notes.value.findIndex(item => item.id === Number(event.entity_id))
      if (event.operation === 'delete') { if (index >= 0) notes.value.splice(index, 1); return index >= 0 }
      if (index >= 0) notes.value.splice(index, 1, note)
      else if (event.operation === 'create') notes.value = [note, ...notes.value].sort(byCapturedDesc)
      else return false
      return true
    }
    if (kind === 'canvas') {
      const canvas = value as MindCanvas
      const index = canvases.value.findIndex(item => item.id === Number(event.entity_id))
      if (event.operation === 'delete') { if (index >= 0) canvases.value.splice(index, 1); return index >= 0 }
      if (index >= 0) canvases.value.splice(index, 1, canvas)
      else if (event.operation === 'create') canvases.value = [canvas, ...canvases.value]
      else return false
      return true
    }
    return false
  }
  watch(() => live.resourceEvent, (event) => {
    if (!event || event.resource !== 'mind' || !loaded.value) return
    if (!applyCanonicalEvent(event)) {
      requestMindRefresh()
    }
  })
  watch(() => live.rev.mind, () => {
    requestMindRefresh()
  })

  return {
    notes, loading, loaded, loadingMore, hasMore, filterQ, jumpTarget, timeline, fetchNotes, loadMoreNotes, createNote, updateNote, deleteNote,
    canvases, canvasesLoaded, canvasLoading, activeCanvasId, canvasItems, canvasRelations,
    fetchCanvases, createCanvas, renameCanvas, deleteCanvas, loadCanvas, addNoteToCanvas, updateCanvasItem,
    addRefToCanvas, addProjectRefOptimistic, createCanvasNote, updateCanvasNote, removeCanvasItem, returnCanvasItemToDrawer, createCanvasRelation, addOptimisticCanvasRelation, replaceOptimisticCanvasRelation, rollbackOptimisticCanvasRelation, removeCanvasRelation, nextCanvasZ, bringCanvasItemToFront,
    saveCanvasView, saveCanvasRelationAnchors,
  }
})
