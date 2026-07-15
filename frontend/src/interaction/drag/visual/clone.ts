const INHERITED_TEXT_PROPERTIES = [
  'font-family', 'font-kerning', 'font-feature-settings', 'font-variation-settings',
  'font-optical-sizing', 'font-synthesis', 'letter-spacing', 'word-spacing', 'text-rendering',
]

export interface DragCloneOptions {
  addClasses?: string[]
  removeClasses?: string[]
}

export function copyInheritedTextStyle(source: HTMLElement, clone: HTMLElement): void {
  const style = getComputedStyle(source)
  for (const property of INHERITED_TEXT_PROPERTIES) {
    clone.style.setProperty(property, style.getPropertyValue(property))
  }
}

/** 创建脱离原布局上下文的视觉副本，具体定位和动画由调用方负责。 */
export function cloneForDrag(source: HTMLElement, options: DragCloneOptions = {}): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  copyInheritedTextStyle(source, clone)
  for (const className of options.removeClasses ?? []) clone.classList.remove(className)
  for (const className of options.addClasses ?? []) clone.classList.add(className)
  return clone
}
