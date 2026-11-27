import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { FloatingChatPlatform } from '../contracts.js'

interface ChatFabNative {
  setChatFabGlass?(handle: Buffer, enabled: boolean): boolean
  preventChatFabActivation?(handle: Buffer): boolean
}

export function createMacFloatingChat(preload: string): FloatingChatPlatform {
  let native: ChatFabNative = {}
  try {
    native = createRequire(import.meta.url)(join(dirname(preload), '..', 'native', 'chat-fab-glass.node'))
  } catch {
    console.warn('无法加载聊天悬浮球毛玻璃')
  }
  const { setChatFabGlass, preventChatFabActivation } = native
  const preventActivation: FloatingChatPlatform['preventActivation'] = preventChatFabActivation
    ? window => { preventChatFabActivation(window.getNativeWindowHandle()) }
    : undefined
  return {
    windowOptions: { type: 'panel' },
    configureWindow(window) {
      window.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false, skipTransformProcessType: true })
      preventActivation?.(window)
    },
    preventActivation,
    setGlass: setChatFabGlass ? (window, enabled) => setChatFabGlass(window.getNativeWindowHandle(), enabled) : undefined,
    // 聚焦独立浮窗可能同时激活主窗，独立模式由用户直接操作浮窗时聚焦。
    canFocus: detached => !detached,
  }
}
