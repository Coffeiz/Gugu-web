export function revealWithoutStaleHover(
  el: HTMLElement,
  pointerMode: boolean,
  onSettled?: () => void,
  keepControls = false,
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
    el.classList.remove('phys-just-revealed')
    if (keepControls) requestAnimationFrame(() => el.classList.remove('phys-reveal-controls'))
  })
  if (pointerMode) {
    onSettled?.()
    return
  }
  el.style.pointerEvents = 'none'
  setTimeout(() => {
    el.style.pointerEvents = ''
    onSettled?.()
  }, 160)
}

export function holdHoverUntilReveal(el: HTMLElement): void {
  el.classList.add('phys-just-revealed')
}
