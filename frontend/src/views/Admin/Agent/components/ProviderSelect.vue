<template>
  <div ref="wrapRef" class="provider-select">
    <button type="button" class="provider-trigger" :class="{ open: open }" @click="open = !open">
      <span>{{ selectedLabel }}</span>
      <FlipChevron :open="open" :size="11" class="provider-chevron" />
    </button>
    <PopupMenu :show="open" :anchor="wrapRef" :popup-class="popupClass ? `provider-popup ${popupClass}` : 'provider-popup'">
      <div v-for="provider in providers" :key="provider.key" class="provider-option-group">
        <button
          type="button"
          class="provider-option"
          :class="{ active: provider.key === activeProvider, expanded: provider.key === expandedProvider }"
          @mousedown.prevent="selectProvider(provider, $event)"
        >
          <span>{{ provider.label }}</span>
          <FlipChevron v-if="provider.children?.length" :open="provider.key === expandedProvider" :size="10" />
        </button>
      </div>
    </PopupMenu>
    <PopupMenu :show="Boolean(expandedProvider && childAnchor)" :anchor="childAnchor" :popup-class="popupClass ? `provider-child-popup ${popupClass}` : 'provider-child-popup'">
      <button
        v-for="child in expandedChildren"
        :key="child.key"
        type="button"
        class="provider-child"
        :class="{ active: expandedProviderOption && valueFor(expandedProviderOption, child) === modelValue }"
        @mousedown.prevent="selectExpandedChild(child)"
      >{{ child.label }}</button>
    </PopupMenu>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type PropType } from 'vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'
import { useI18n } from 'vue-i18n'

interface ChildOption { key: string; label: string }
interface ProviderOption { key: string; label: string; children?: ChildOption[] }

const props = defineProps({
  modelValue: { type: String, default: '' },
  providers: { type: Array as PropType<ProviderOption[]>, default: () => [] },
  placeholder: { type: String, default: '' },
  popupClass: { type: String, default: '' },
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const { t } = useI18n()
const wrapRef = ref<HTMLElement | null>(null)
const open = ref(false)
const expandedProvider = ref('')
const childAnchor = ref<HTMLElement | null>(null)

const activeProvider = computed(() => props.modelValue.split('|', 1)[0])
const selectedLabel = computed(() => {
  const [providerKey, childKey] = props.modelValue.split('|')
  const provider = props.providers.find(item => item.key === providerKey)
  if (!provider) return props.placeholder || t('adminRuntimeUi.selectProvider')
  const child = provider.children?.find(item => item.key === childKey)
  return child ? `${provider.label} · ${child.label}` : provider.label
})
const expandedChildren = computed(() => props.providers.find(item => item.key === expandedProvider.value)?.children || [])
const expandedProviderOption = computed(() => props.providers.find(item => item.key === expandedProvider.value) || null)

function valueFor(provider: ProviderOption, child: ChildOption) {
  return `${provider.key}|${child.key}`
}

function selectExpandedChild(child: ChildOption) {
  const provider = expandedProviderOption.value
  if (provider) selectChild(provider, child)
}

function selectProvider(provider: ProviderOption, event: MouseEvent) {
  if (provider.children?.length) {
    childAnchor.value = event.currentTarget as HTMLElement
    expandedProvider.value = expandedProvider.value === provider.key ? '' : provider.key
    if (!expandedProvider.value) childAnchor.value = null
    return
  }
  emit('update:modelValue', provider.key)
  open.value = false
  expandedProvider.value = ''
  childAnchor.value = null
}

function selectChild(provider: ProviderOption, child: ChildOption) {
  emit('update:modelValue', valueFor(provider, child))
  open.value = false
  expandedProvider.value = ''
  childAnchor.value = null
}

function closeOnOutside(event: MouseEvent) {
  const target = event.target as Element | null
  if (open.value && !wrapRef.value?.contains(target) && !target?.closest('.provider-popup')) {
    open.value = false
    expandedProvider.value = ''
    childAnchor.value = null
  }
}
onMounted(() => document.addEventListener('mousedown', closeOnOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', closeOnOutside))
</script>

<style scoped>
.provider-select { position:relative; display:inline-block; min-width:220px; }
.provider-trigger { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; height:34px; padding:0 12px; border:1px solid var(--input-border); border-radius:9px; background:var(--input-bg); color:var(--input-fg); font:13px var(--font-sans); cursor:pointer; text-align:left; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.provider-trigger:hover,.provider-trigger.open { border-color:var(--input-border-hover); background:var(--input-bg-hover); }
.provider-chevron { color:var(--popup-item-fg-muted); }
:global(.provider-popup) { min-width:220px; max-height:260px; overflow:auto; }
:global(.provider-popup .provider-option-group + .provider-option-group) { margin-top:1px; }
:global(.provider-popup .provider-option), :global(.provider-child-popup .provider-child) { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; padding:var(--popup-item-padding); border:0; border-radius:var(--popup-item-radius); background:transparent; color:var(--popup-item-fg); font:13px var(--font-sans); text-align:left; cursor:pointer; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
:global(.provider-child-popup) { min-width:150px; }
:global(.provider-popup .provider-option:hover), :global(.provider-popup .provider-option.expanded), :global(.provider-child-popup .provider-child:hover) { background:var(--popup-item-bg-hover); }
:global(.provider-popup .provider-option.active) { color:var(--popup-item-fg-active); }
:global(.provider-child-popup .provider-child.active) { background:var(--popup-item-bg-active); color:var(--popup-item-fg-active); }
</style>
