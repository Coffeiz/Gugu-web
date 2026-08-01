import { DefaultVisualAdapter, runtime } from './index'

/** 看板自己的抓取视觉，不下沉到 Runtime 默认策略，便于其它对象保持原样。 */
class ProjectCardVisualAdapter extends DefaultVisualAdapter {
  constructor(runtime: any) {
    super(runtime)
    // Runtime 会把 createMove 作为注册配置取出后调用；绑定实例避免继承方法
    // 丢失 this，导致 pointerdown 无法创建移动事务。
    this.createMove = this.createMove.bind(this)
  }

  createProxy(context: any) {
    const proxy = super.createProxy(context)
    const content = proxy.element.querySelector<HTMLElement>('[data-runtime-proxy-content]')
    content?.setAttribute('data-project-glass-drag', 'true')
    return proxy
  }

  applyState(element: HTMLElement, state: any): void {
    super.applyState(element, state)
    element.toggleAttribute('data-project-glass-drag', state.phase === 'dragging' && state.grabbed)
  }
}

let initialized = false

/** 应用只注册对象类型与统一运动参数，具体对象和 Surface 由各自组件声明。 */
export function setupInteractionRuntime(): void {
  if (initialized) return
  initialized = true

  runtime.registerObjectType('project-card', {
    defaultVisualMode: 'detach',
    motion: { enabled: true },
    visual: new ProjectCardVisualAdapter(runtime),
  })
  runtime.configureMotion({
    flip: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    resize: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    landing: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    group: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
  })
}
