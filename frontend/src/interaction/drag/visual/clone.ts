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

export interface LandingCloneOptions {
  width: number
  height: number
  layoutWidth: number
  layoutHeight: number
  zIndex: string
  transform: string
  contentScale: number
  cloneClass?: string
}

/** 创建落地阶段的内容副本；定位壳和动画收尾由 landing 运行时负责。 */
export function createLandingClone(source: HTMLElement, options: LandingCloneOptions): HTMLElement {
  const holder = document.createElement('div')
  Object.assign(holder.style, {
    position: 'fixed', left: '0', top: '0',
    width: options.width + 'px', height: options.height + 'px',
    margin: '0', boxSizing: 'border-box', zIndex: options.zIndex, pointerEvents: 'none',
    willChange: 'transform', transition: 'none', opacity: '0', transform: options.transform,
  })
  const content = cloneForDrag(source, {
    addClasses: ['phys-landing-content'],
    removeClasses: ['phys-drag-source', 'phys-reveal-controls', 'phys-drag-source-placeholder'],
  })
  if (options.cloneClass) content.classList.add(options.cloneClass)
  content.querySelectorAll('.card-conn-dots').forEach(dot => dot.remove())
  content.querySelectorAll<HTMLElement>('.card-actions, .nc-actions').forEach(action => {
    action.style.visibility = 'hidden'
  })
  const scaleShell = document.createElement('div')
  Object.assign(scaleShell.style, {
    position: 'absolute', left: '0', top: '0',
    width: options.layoutWidth + 'px', height: options.layoutHeight + 'px',
    transformOrigin: '0 0', transform: `scale(${options.contentScale})`, pointerEvents: 'none',
  })
  Object.assign(content.style, {
    left: '', top: '', right: '', bottom: '', opacity: '', zIndex: '',
    width: options.layoutWidth + 'px',
  })
  scaleShell.appendChild(content)
  holder.appendChild(scaleShell)
  document.body.appendChild(holder)
  return holder
}
