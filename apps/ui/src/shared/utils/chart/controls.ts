export type ChartControlOptions = {
  action: string
  label: string
  text?: string
  content?: Node
  className?: string
  data?: Record<string, string>
  pressed?: boolean
}

const boundToolbars = new WeakSet<HTMLElement>()

/** 图表与公式共用的控制按钮结构与可访问名称。 */
export function createChartControl(options: ChartControlOptions): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.chartAction = options.action
  button.setAttribute('aria-label', options.label)
  button.title = options.label
  if (options.className) button.className = options.className
  if (options.pressed !== undefined) button.setAttribute('aria-pressed', String(options.pressed))
  Object.entries(options.data || {}).forEach(([key, value]) => {
    button.dataset[key] = value
  })
  if (options.content) button.append(options.content)
  else if (options.text) button.textContent = options.text
  return button
}

/** 创建控制栏共用的 SVG 图标。 */
export function createChartControlIcon(pathData: string): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('d', pathData)
  svg.append(path)
  return svg
}

/** 指针操作后释放焦点，避免 :focus-within 让控制栏在指针离开后常驻。 */
export function bindChartControls(controls: HTMLElement): void {
  controls.classList.add('md-chart-controls')
  if (boundToolbars.has(controls)) return
  boundToolbars.add(controls)
  controls.addEventListener('click', (event: MouseEvent) => {
    if (event.detail <= 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    target.closest<HTMLButtonElement>('button')?.blur()
  })
}

/** 将按钮装入统一图表控制栏，并连接相同的焦点收起行为。 */
export function createChartControls(
  variants: string[],
  buttons: HTMLButtonElement[],
): HTMLDivElement {
  const controls = document.createElement('div')
  controls.classList.add(...variants)
  controls.append(...buttons)
  bindChartControls(controls)
  return controls
}
