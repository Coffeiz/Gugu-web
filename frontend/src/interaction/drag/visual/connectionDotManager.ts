let activeDot: HTMLElement | null = null

export function acquireConnectionDot(source: HTMLElement): HTMLElement {
  if (activeDot) {
    activeDot.className = `${source.className} phys-conn-dot-manager`
    activeDot.dataset.nodeId = source.dataset.nodeId ?? ''
    return activeDot
  }
  activeDot = source.cloneNode(true) as HTMLElement
  activeDot.classList.remove('phys-conn-dot-overlay')
  activeDot.classList.add('phys-conn-dot-manager')
  return activeDot
}

export function releaseConnectionDot(dot?: HTMLElement): void {
  if (!dot || activeDot !== dot) return
  dot.remove()
  activeDot = null
}
