import { onScopeDispose } from 'vue'
import { toPng } from 'html-to-image'
import { runtime } from '@/interaction/runtime'

/** 窗口内由 Runtime 跟手；鼠标越过视口时，把同一次拖动交给系统。 */
export function useDesktopFileDrag() {
  let stop: (() => void) | undefined
  function clearDragClickGuard() {
    window.removeEventListener('click', suppressDragClick, true)
    window.removeEventListener('pointerdown', clearDragClickGuard, true)
  }
  function suppressDragClick(event: MouseEvent) {
    // 键盘激活没有点击次数，也不属于这次指针手势。
    if (event.detail === 0) return
    clearDragClickGuard()
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  onScopeDispose(() => {
    stop?.()
    clearDragClickGuard()
  })

  return (event: PointerEvent, objectId: string, startNativeDrag: (preview?: string) => void) => {
    const target = event.currentTarget
    if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary || !(target instanceof HTMLElement)) return
    const card = target
    if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable], .file-card-hover-actions')) return
    stop?.()
    const pointerId = event.pointerId
    let sessionId: string | undefined
    let preview: Promise<string | undefined> | undefined
    let handingOff = false

    function move(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId) return
      if (!(pointer.buttons & 1)) { cleanup(); return }
      if (!sessionId || handingOff || (pointer.clientX >= 0 && pointer.clientX < window.innerWidth
        && pointer.clientY >= 0 && pointer.clientY < window.innerHeight)) return
      const active = sessionId
      handingOff = true
      void Promise.resolve(preview).then(image => {
        if (stop !== cleanup) return
        cleanup()
        runtime.cancel(active, 'native-file-drag')
        startNativeDrag(image)
      })
    }

    const finish = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) cleanup() }
    const unsubscribe = runtime.subscribe(change => {
      if ((change.type !== 'move-visual-update' && change.type !== 'move-visual-end') || change.objectId !== objectId) return
      if (change.type === 'move-visual-update' && change.phase === 'active' && !sessionId) {
        sessionId = change.sessionId
        // 捕获指针后，松手仍可能在卡片上合成 click，甚至落到文件名按钮上。
        window.addEventListener('click', suppressDragClick, true)
        window.addEventListener('pointerdown', clearDragClickGuard, true)
        if (!card.hasPointerCapture(pointerId)) card.setPointerCapture(pointerId)
        const proxy = runtime.getVisualProxy(sessionId)?.element
        const cardSelector = '.fc-card, .folder-card'
        const visual = proxy?.matches(cardSelector) ? proxy : proxy?.querySelector<HTMLElement>(cardSelector)
        preview = toPng(visual ?? card, {
          pixelRatio: 1,
          canvasWidth: Math.min(512, Math.ceil(change.rect.width)),
          canvasHeight: Math.min(512, Math.ceil(change.rect.height)),
          skipFonts: true,
          includeQueryParams: true,
          style: { transform: 'none', margin: '0', backdropFilter: 'none' },
        }).catch(() => undefined)
      } else if (change.type === 'move-visual-end' && change.sessionId === sessionId) cleanup()
    })

    function cleanup() {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('blur', cleanup)
      unsubscribe()
      if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId)
      if (stop === cleanup) stop = undefined
    }

    stop = cleanup
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
    window.addEventListener('blur', cleanup)
  }
}
