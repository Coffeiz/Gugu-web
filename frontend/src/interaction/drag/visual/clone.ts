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
  // 已完成列的卡片位于年/月分组内，部分视觉变量来自列级祖先。克隆挂到 body 后会切断
  // 这条继承链；只复制自定义变量，不把祖先的布局属性带进克隆，避免再次改变卡片尺寸。
  for (let i = 0; i < style.length; i += 1) {
    const property = style.item(i)
    if (property.startsWith('--')) clone.style.setProperty(property, style.getPropertyValue(property))
  }
}

/** 创建脱离原布局上下文的视觉副本，具体定位和动画由调用方负责。 */
export function cloneForDrag(source: HTMLElement, options: DragCloneOptions = {}): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  copyInheritedTextStyle(source, clone)
  // 克隆保留源卡片的占位结构，保证克隆1与本体使用完全相同的盒模型；目标列的尺寸变化
  // 交给后续 clone2 落地动画处理，不能在这里提前补普通列按钮空间而改变文本换行。
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
  attitudeTransform?: string
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
    // landing 与 grabbing 共享同一个内容层起始态。morph lifecycle 会在首帧提交后摘掉
    // phys-drag-clone，让它从玻璃拖拽态平滑过渡到目标本体样式。
    addClasses: ['phys-landing-content', 'phys-drag-clone'],
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
    // holder 以源卡屏幕尺寸为基准，内容却按目标卡布局。先把目标内容缩到源卡尺寸，随后
    // holder 的形变再从源尺寸放大到目标尺寸，最终正好还原成目标卡的真实屏幕尺寸。
    // 不能只套 contentScale：那会让两行目标卡在飞行一开始就按 114px 渲染，随后又被 holder
    // 再缩放一次，形成视觉上的双重高度形变。
    transformOrigin: '0 0',
    transform: `scale(${options.width / options.layoutWidth}, ${options.height / options.layoutHeight})`,
    pointerEvents: 'none',
  })
  Object.assign(content.style, {
    left: '', top: '', right: '', bottom: '', opacity: '', zIndex: '',
    width: options.layoutWidth + 'px',
  })
  // 姿态单独分层：保留拖拽最后一帧的旋转，但不让旋转后的包围盒污染 morph 尺寸。
  const attitude = document.createElement('div')
  attitude.className = 'phys-landing-attitude'
  Object.assign(attitude.style, {
    position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
    transformOrigin: '50% 50%', transform: options.attitudeTransform ?? 'none',
    transition: 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)', pointerEvents: 'none',
  })
  attitude.appendChild(scaleShell)
  scaleShell.appendChild(content)
  holder.appendChild(attitude)
  document.body.appendChild(holder)
  return holder
}
