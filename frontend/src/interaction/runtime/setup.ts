import { runtime } from './index'

let initialized = false

/** 应用只注册对象类型与统一运动参数，具体对象和 Surface 由各自组件声明。 */
export function setupInteractionRuntime(): void {
  if (initialized) return
  initialized = true

  runtime.registerObjectType('project-card', {
    defaultVisualMode: 'detach',
    motion: { enabled: true },
  })
  runtime.configureVisual({ dragGlass: true })
  runtime.configureMotion({
    flip: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    resize: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    landing: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
    group: { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' },
  })
}
