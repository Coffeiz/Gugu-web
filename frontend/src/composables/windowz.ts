/** 全局窗口层级管理：所有浮动窗口/弹层统一从这里领 z——点谁谁到最上层。
 *
 * z 带划分（历史各据一方：BaseModal 200 / 气泡·拖拽克隆 9999 / GuguChat 10000 / 预览窗 11000，
 * 互不知情、谁盖谁看出生数字。统一为）：
 *   - 页面内元素            < 10000（各页面自理）
 *   - OVERLAY_Z = 19000     modal 遮罩带：固定、在一切窗口之下 → backdrop 模糊只糊页面，
 *                           永远糊不到任何浮动窗口（预览器/聊天窗…）
 *   - 窗口带 20000+ 递增     窗口(nextZ 领号)与 popover 共用一带：popover 弹出即当前最顶
 *   - TOP_Z = 100000        压顶带：通知气泡 / toast / 拖拽克隆体（永远可见）
 *
 * ESC 语义：只关「z 最大的活动层」（registerEsc）。窗口自身不要再各自监听 document ESC。
 */

export const OVERLAY_Z = 19000
export const TOP_Z = 100000

let _z = 20000

/** 领一个新的最顶 z。窗口打开时、被 mousedown 时、popover 弹出时调用。 */
export function nextZ(): number {
  return ++_z
}

// ── ESC 只关最顶层 ───────────────────────────────────────────────────────────
interface EscLayer { getZ: () => number; close: () => void }

const _escLayers = new Set<EscLayer>()
let _escBound = false

function _onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || _escLayers.size === 0) return
  let top: EscLayer | null = null
  for (const l of _escLayers) {
    if (!top || l.getZ() > top.getZ()) top = l
  }
  if (top) {
    e.stopPropagation()   // capture 阶段拦下，防止其他全局 ESC 监听同时关别的
    top.close()
  }
}

/** 注册一个 ESC 可关闭层（窗口打开时注册、关闭时调返回的注销函数）。
 *  按 ESC 只有 getZ() 最大的那个会被 close。 */
export function registerEsc(layer: EscLayer): () => void {
  _escLayers.add(layer)
  if (!_escBound) {
    _escBound = true
    document.addEventListener('keydown', _onKeydown, true)   // capture：先于组件局部监听
  }
  return () => { _escLayers.delete(layer) }
}
