import { ref, type Ref } from 'vue'

export interface FileContextMenuState<TType extends string, TTarget> {
  visible: boolean
  x: number
  y: number
  type: TType | null
  target: TTarget | null
}

export function useFileContextMenu<TType extends string, TTarget>(initialType: TType | null = null) {
  const state: Ref<FileContextMenuState<TType, TTarget>> = ref({
    visible: false,
    x: 0,
    y: 0,
    type: initialType,
    target: null,
  }) as Ref<FileContextMenuState<TType, TTarget>>

  function open(type: TType, target: TTarget | null, event: MouseEvent) {
    state.value = {
      visible: true,
      x: event.clientX,
      y: event.clientY,
      type,
      target,
    }
  }

  function close() {
    state.value.visible = false
  }

  return { state, open, close }
}
