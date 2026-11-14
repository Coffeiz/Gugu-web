import { onUnmounted, ref, watch } from 'vue'
import { runtime, bindRuntimeObjectPointer, type TargetItem } from '@/interaction/runtime'

interface FileRuntimeDefinition {
  type: string
  surfaceId: string
  abilities: readonly string[]
  selected: boolean
  target?: Omit<TargetItem, 'id' | 'element' | 'generation'>
}

/** 文件卡片和列表行共用对象与指针生命周期；目录 surface 仍由目录包装器持有。 */
export function useFileRuntimeObject(id: () => string, definition: () => FileRuntimeDefinition) {
  const elementRef = ref<HTMLElement | null>(null)
  const snapshot = () => {
    const value = definition()
    return { ...value, abilities: [...value.abilities] }
  }
  const generation = runtime.objects.register({ id: id(), ...snapshot(), element: null })
  let stopPointerBinding: (() => void) | null = null

  watch(snapshot, value => {
    if (runtime.objects.get(id())?.generation !== generation) return
    runtime.objects.update(id(), value)
  }, { deep: true })
  watch(elementRef, (element, previous) => {
    const current = runtime.objects.get(id())
    if (current?.generation !== generation) return
    if (element === null && current.element && current.element !== previous) return
    stopPointerBinding?.()
    stopPointerBinding = element ? bindRuntimeObjectPointer(id(), element) : null
    runtime.objects.setElement(id(), element)
  }, { flush: 'post' })

  onUnmounted(() => {
    stopPointerBinding?.()
    if (runtime.objects.get(id())?.generation === generation) runtime.unregisterObjectWhenIdle(id(), generation)
  })
  return { elementRef, generation }
}
