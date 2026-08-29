import { shallowRef } from 'vue'

export type ConfirmTone = 'neutral' | 'warning' | 'danger'

export interface ConfirmDialogOptions {
  title: string
  message: string
  tone?: ConfirmTone
  confirmText?: string
  cancelText?: string
}

export interface ActiveConfirmDialog extends Required<ConfirmDialogOptions> {
  resolve: (value: boolean) => void
}

const active = shallowRef<ActiveConfirmDialog | null>(null)
const queue: ActiveConfirmDialog[] = []
let closing = false

function showNext() {
  if (active.value || closing) return
  active.value = queue.shift() ?? null
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise(resolve => {
    queue.push({
      title: options.title,
      message: options.message,
      tone: options.tone ?? 'neutral',
      confirmText: options.confirmText ?? '确定',
      cancelText: options.cancelText ?? '取消',
      resolve,
    })
    showNext()
  })
}

export function useConfirmDialog() {
  function settle(value: boolean) {
    const request = active.value
    if (!request) return
    active.value = null
    closing = true
    request.resolve(value)
    window.setTimeout(() => {
      closing = false
      showNext()
    }, 240)
  }

  return { active, settle }
}
