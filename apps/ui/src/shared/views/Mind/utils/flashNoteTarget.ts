export function flashNoteTarget(element: HTMLElement) {
  const marker = 'search-highlight'
  if (element.classList.contains(marker)) {
    element.classList.remove(marker)
    // 同一张卡片被连续定位时，也从头播放高亮。
    void element.offsetWidth
  }
  element.classList.add(marker)
  element.addEventListener('animationend', function clearHighlight(event) {
    if (event.target !== element || event.animationName !== 'search-highlight-pulse') return
    element.classList.remove(marker)
    element.removeEventListener('animationend', clearHighlight)
  })
}
