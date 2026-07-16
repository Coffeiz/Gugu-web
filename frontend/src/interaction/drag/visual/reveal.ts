export function revealWithoutStaleHover(
  el: HTMLElement,
  pointerMode: boolean,
  onSettled?: () => void,
  keepControls = false,
  isActive: () => boolean = () => true,
): void {
  el.classList.add('phys-just-revealed')
  el.classList.add('phys-reveal-snap')
  if (keepControls) el.classList.add('phys-reveal-controls')
  el.style.opacity = ''
  if (pointerMode && (keepControls || el.matches(':hover'))) {
    el.dispatchEvent(new MouseEvent('mouseenter'))
  }
  void el.offsetWidth
  el.classList.remove('phys-reveal-snap')
  requestAnimationFrame(() => {
    // pointer 模式下 finishSession 可能在同一轮调用栈里结束 session；这个视觉清理不能
    // 因此被 isActive 拦掉，否则 phys-just-revealed 会永久留在卡片上并被下一次克隆继承。
    el.classList.remove('phys-just-revealed')
    if (keepControls) requestAnimationFrame(() => {
      el.classList.remove('phys-reveal-controls')
    })
  })
  if (pointerMode) {
    onSettled?.()
    return
  }
  el.style.pointerEvents = 'none'
  setTimeout(() => {
    if (!isActive()) return
    el.style.pointerEvents = ''
    onSettled?.()
  }, 160)
}

export function holdHoverUntilReveal(el: HTMLElement): void {
  el.classList.add('phys-just-revealed')
}
