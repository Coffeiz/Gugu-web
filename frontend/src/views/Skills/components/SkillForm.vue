<template>
  <BaseModal :show="true" width="620px" background="var(--panel-bg)" @close="emit('close')">
    <div class="skill-form">
      <div class="form-head">
        <div><h2>{{ skill ? '编辑技能' : '新建技能' }}</h2><p>定义做事方法，不会新增或绕过工具权限。</p></div>
        <CloseButton @click="emit('close')" />
      </div>
      <label>名称<input v-model="form.name" maxlength="120" placeholder="例如：晨间简报" /></label>
      <label class="description-field"><span class="field-label"><span>简介（短描述）</span><small>{{ form.description_short.length }}/100 字符，用于技能目录和匹配提示</small></span><textarea ref="descriptionRef" v-model="form.description_short" class="short-description" maxlength="100" rows="2" placeholder="什么时候使用这个技能？" @input="resizeDescription" /></label>
      <label>技能正文<textarea ref="bodyRef" v-model="form.body" class="skill-body" maxlength="20000" rows="8" placeholder="写下咕咕应遵循的步骤和输出格式，不要写可执行代码。" @input="resizeBody" /></label>
      <div class="form-label tool-label"><span><b>可关联工具</b><em>仅表示建议使用，实际权限仍由工具注册表决定</em></span><button type="button" class="tool-toggle" @click="toolsExpanded = !toolsExpanded">{{ toolsExpanded ? '收起' : '展开' }}</button></div>
      <div v-if="toolsExpanded" class="tool-grid">
        <div v-for="tool in tools" :key="tool.name" class="tool-option" @click="toggleTool(tool.name, !form.related_tools.includes(tool.name))">
          <span class="tool-copy"><b>{{ tool.name }}</b><small>{{ tool.description_short }}</small></span>
          <Checkbox :model-value="form.related_tools.includes(tool.name)" :aria-label="tool.name" @click.stop @update:model-value="setTool(tool.name, $event)" />
        </div>
      </div>
      <p v-if="error || props.externalError" class="form-error">{{ error || props.externalError }}</p>
      <div class="form-actions"><Checkbox v-model="form.enabled" class="enabled-row">启用</Checkbox><span class="form-action-spacer" /><ActionButton variant="secondary" @click="emit('close')">取消</ActionButton><ActionButton :disabled="busy" @click="submit">{{ busy ? '保存中…' : '保存' }}</ActionButton></div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import ActionButton from '@/components/common/ActionButton.vue'
import Checkbox from '@/components/common/Checkbox.vue'
import CloseButton from '@/components/common/CloseButton.vue'
import Icon from '@/components/common/Icon.vue'
import type { SkillToolItem, UserSkillItem, UserSkillWrite } from '@/services/api'

const props = defineProps<{ skill: UserSkillItem | null; tools: SkillToolItem[]; busy?: boolean; externalError?: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'save', data: UserSkillWrite): void }>()
const error = ref('')
const toolsExpanded = ref(false)
const descriptionRef = ref<HTMLTextAreaElement | null>(null)
const bodyRef = ref<HTMLTextAreaElement | null>(null)
const form = reactive({
  slug: props.skill?.slug ?? '', name: props.skill?.name ?? '',
  description_short: props.skill?.description_short ?? '', description_long: props.skill?.description_long ?? '',
  category: props.skill?.category ?? 'personal', related_tools: [...(props.skill?.related_tools ?? [])],
  body: props.skill?.body ?? '', enabled: props.skill?.enabled ?? true,
})

function submit() {
  error.value = ''
  if (!form.name.trim() || !form.description_short.trim() || !form.body.trim()) {
    error.value = '请填写名称、简介和正文'
    return
  }
  const slug = form.slug || `user-skill-${Date.now().toString(36)}`
  emit('save', { ...form, slug, description_long: props.skill?.description_long ?? null })
}

function resizeTextarea(textarea: HTMLTextAreaElement, maxHeight: number, minHeight: number) {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`
}
function resizeDescription(event: Event) {
  resizeTextarea(event.currentTarget as HTMLTextAreaElement, 90, 54)
}
function resizeBody(event: Event) {
  resizeTextarea(event.currentTarget as HTMLTextAreaElement, 320, 128)
}
function setTool(name: string, checked: boolean) {
  const tools = new Set(form.related_tools)
  if (checked) tools.add(name)
  else tools.delete(name)
  form.related_tools = [...tools]
}
function toggleTool(name: string, checked: boolean) { setTool(name, checked) }
onMounted(() => {
  nextTick(() => {
    if (descriptionRef.value) resizeTextarea(descriptionRef.value, 90, 54)
    if (bodyRef.value) resizeTextarea(bodyRef.value, 320, 128)
  })
})
</script>

<style scoped>
.skill-form { position:relative; z-index:1; isolation:isolate; padding:24px; color:var(--content-primary); max-height:calc(100vh - 48px); overflow-y:auto; scrollbar-gutter:stable; scrollbar-width:thin; }
.form-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; }.form-head h2 { font-size:20px; margin:0; }.form-head p { color:var(--content-secondary); font-size:12px; margin:6px 0 0; }
label:not(.app-checkbox), .form-label { display:flex; flex-direction:column; gap:6px; color:var(--content-secondary); font-size:12px; margin-top:13px; }.form-label span { font-size:11px; color:var(--content-tertiary); font-weight:400; }.field-label { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }.field-label small { color:var(--content-tertiary); font-size:11px; font-weight:400; }
input:not([type="checkbox"]), textarea { box-sizing:border-box; width:100%; border:1px solid var(--control-border); background:var(--control-bg); color:var(--content-primary); border-radius:var(--radius-sm); padding:9px 10px; font:inherit; outline:none; resize:none; }.short-description { min-height:54px; max-height:90px; overflow-y:auto; line-height:1.5; }.skill-body { min-height:128px; max-height:320px; overflow-y:auto; line-height:1.55; }.skill-form input:not([type="checkbox"]):focus, .skill-form textarea:focus { border-color:var(--border-focus); box-shadow:var(--control-focus-shadow); }.skill-form input:disabled { opacity:.55; }
.tool-label { flex-direction:row; align-items:center; justify-content:space-between; }.tool-label > span { display:flex; flex-direction:column; gap:3px; }.tool-label b { color:var(--content-secondary); font-weight:500; }.tool-label em { color:var(--content-tertiary); font-size:11px; font-style:normal; font-weight:400; }.tool-toggle { min-height:28px; border:1px solid var(--action-outline); padding:4px 10px; border-radius:var(--radius-sm); color:var(--selection-fg); background:var(--action-soft); cursor:pointer; font:500 11px var(--font-sans); transition:background-color var(--motion-hover-control) var(--motion-ease-standard),border-color var(--motion-hover-control) var(--motion-ease-standard),color var(--motion-hover-control) var(--motion-ease-standard); }.tool-toggle:hover { color:var(--content-primary); border-color:var(--action-primary); background:var(--action-soft-hover); }
.tool-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:8px; }.tool-option { display:flex; flex-direction:row; align-items:center; gap:8px; padding:10px; margin:0; border:1px solid var(--border-default); border-radius:var(--control-radius); background:color-mix(in srgb,var(--surface-card-solid) 88%,var(--surface-glass)); box-shadow:var(--elevation-card); color:var(--content-secondary); cursor:pointer; transition:background-color var(--motion-hover-control) var(--motion-ease-standard),border-color var(--motion-hover-control) var(--motion-ease-standard),box-shadow var(--motion-hover-control) var(--motion-ease-standard); }.tool-option:hover { background:color-mix(in srgb,var(--surface-card-solid) 96%,var(--surface-glass-hover)); border-color:var(--border-hover); box-shadow:var(--elevation-card-hover); }.tool-option:has(input:checked) { background:color-mix(in srgb,var(--selection-bg) 72%,var(--surface-card-solid)); border-color:var(--action-outline); color:var(--selection-fg); }.tool-copy { order:1; display:flex; flex-direction:column; gap:3px; min-width:0; }.tool-option > .app-checkbox { order:2; margin-left:auto; }.tool-option b { color:var(--content-primary); font-size:12px; }.tool-option small { color:var(--content-tertiary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.enabled-row { flex:0 0 auto; flex-direction:row; align-items:center; gap:8px; min-height:34px; box-sizing:border-box; padding:7px 0; margin:0; color:var(--content-secondary); }.form-action-spacer { flex:1; }.form-error { color:var(--danger-fg); font-size:12px; margin:12px 0 0; }.form-actions { display:flex; align-items:center; justify-content:flex-end; gap:10px; margin-top:22px; }
@media(max-width:620px){.tool-grid{grid-template-columns:1fr}}
</style>
