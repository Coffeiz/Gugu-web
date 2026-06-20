import { ref } from 'vue'

const STORAGE_KEY = 'gugu_stage_templates'

const DEFAULT_TEMPLATES = [
  { id: 'default_1', name: '标准流程', stages: ['计划', '执行', '交付'] },
  { id: 'default_2', name: '插画流程', stages: ['草稿', '线稿', '上色', '交付'] },
  { id: 'default_3', name: '动画流程', stages: ['分镜', '原画', '动画', '后期', '交付'] },
]

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : [...DEFAULT_TEMPLATES]
  } catch {
    return [...DEFAULT_TEMPLATES]
  }
}

function save(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

const templates = ref(load())

export function useStageTemplates() {
  function applyTemplate(id) {
    return templates.value.find(t => t.id === id)?.stages ?? null
  }

  function addTemplate(name, stages) {
    const trimmed = name.trim()
    if (!trimmed || !stages.length) return false
    // 同名覆盖
    const existing = templates.value.find(t => t.name === trimmed)
    if (existing) {
      existing.stages = [...stages]
    } else {
      templates.value.push({ id: `tpl_${Date.now()}`, name: trimmed, stages: [...stages] })
    }
    save(templates.value)
    return true
  }

  function removeTemplate(id) {
    const idx = templates.value.findIndex(t => t.id === id)
    if (idx !== -1) { templates.value.splice(idx, 1); save(templates.value) }
  }

  function renameTemplate(id, name) {
    const t = templates.value.find(t => t.id === id)
    if (t) { t.name = name.trim(); save(templates.value) }
  }

  return { templates, applyTemplate, addTemplate, removeTemplate, renameTemplate }
}
