// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isBuiltinTemplateTranslation,
  localizeSavedBuiltinTemplates,
} from '@/composables/projects/useStageTemplates'

const knownTranslations: Record<string, string[]> = {
  'projects.templateStandard': ['Standard workflow', '标准流程', '標準フロー'],
  'projects.defaultPlan': ['Plan', '计划', '計画'],
  'projects.defaultExecution': ['Execution', '执行', '実行'],
  'projects.defaultDelivery': ['Delivery', '交付', '納品'],
  'projects.templateIllustration': ['Illustration workflow', '插画流程', 'イラスト制作'],
  'projects.stageDraft': ['Draft', '草稿', '下書き'],
  'projects.stageLineart': ['Line art', '线稿', '線画'],
  'projects.stageColoring': ['Coloring', '上色', '着彩'],
  'projects.templateAnimation': ['Animation workflow', '动画流程', 'アニメーション制作'],
  'projects.stageStoryboard': ['Storyboard', '分镜', '絵コンテ'],
  'projects.stageKeyAnimation': ['Key animation', '原画'],
  'projects.stageAnimation': ['Animation', '动画', 'アニメーション'],
  'projects.stagePostProduction': ['Post-production', '后期制作', 'ポストプロダクション'],
}

const matchesBuiltinTranslation = (value: string, key: string) => knownTranslations[key]?.includes(value) ?? false
const projectModalSource = readFileSync('src/views/Projects/components/NewProjectModal.vue', 'utf8')

function styleDeclarations(selector: string): Record<string, string> {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = projectModalSource.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))?.[1] ?? ''
  return Object.fromEntries(rule.split(';')
    .map(declaration => declaration.trim().split(/:\s*/, 2))
    .filter(([property, value]) => Boolean(property && value)))
}

describe('内置阶段模板本地化逻辑', () => {
  it('无论当前界面语言为何，都能识别不同语言保存的内置文案', () => {
    expect(isBuiltinTemplateTranslation('Illustration workflow', 'projects.templateIllustration')).toBe(true)
    expect(isBuiltinTemplateTranslation('插画流程', 'projects.templateIllustration')).toBe(true)
    expect(isBuiltinTemplateTranslation('自定义插画流程', 'projects.templateIllustration')).toBe(false)
    expect(isBuiltinTemplateTranslation('Execution', 'projects.templateStandard')).toBe(false)
  })

  it('在中文界面把已保存的英文内置模板和阶段名显示为中文', () => {
    const saved = [{
      id: 'default_2',
      name: 'Illustration workflow',
      stages: [
        { label: 'Draft', todos: [{ id: 'todo-1', text: '保留待办', done: false }] },
        { label: 'Line art', todos: [] },
        { label: 'Coloring', todos: [] },
        { label: 'Delivery', todos: [] },
      ],
    }]
    const localizedDefaults = [{
      id: 'default_2',
      name: '插画流程',
      stages: ['草稿', '线稿', '上色', '交付'].map(label => ({ label, todos: [] })),
    }]

    const result = localizeSavedBuiltinTemplates(saved, localizedDefaults, matchesBuiltinTranslation)

    expect(result[0].name).toBe('插画流程')
    expect(result[0].stages.map(stage => typeof stage === 'string' ? stage : stage.label))
      .toEqual(['草稿', '线稿', '上色', '交付'])
    expect(result[0].stages[0]).toEqual({
      label: '草稿',
      todos: [{ id: 'todo-1', text: '保留待办', done: false }],
    })
    expect(saved[0].name).toBe('Illustration workflow')
  })

  it('只翻译仍是内置文案的部分，保留用户重命名和自定义阶段', () => {
    const saved = [{
      id: 'default_1',
      name: '我的工作流',
      stages: [{ label: 'Research', todos: [] }, { label: 'Execution', todos: [] }],
    }]
    const localizedDefaults = [{
      id: 'default_1',
      name: '标准流程',
      stages: ['计划', '执行', '交付'].map(label => ({ label, todos: [] })),
    }]

    const result = localizeSavedBuiltinTemplates(saved, localizedDefaults, matchesBuiltinTranslation)

    expect(result[0].name).toBe('我的工作流')
    expect(result[0].stages).toEqual([
      { label: 'Research', todos: [] },
      { label: '执行', todos: [] },
    ])
  })

})

describe('新建项目模板区的静态布局约束', () => {
  it('阶段预览裁切长文案时保留下伸字形所需行高并启用省略', () => {
    expect(styleDeclarations('.tpl-stages-preview')).toMatchObject({
      'line-height': '1.5',
      overflow: 'hidden',
      'text-overflow': 'ellipsis',
    })
  })

  it('模板重命名复用单层输入框并为按钮预留尾部空间', () => {
    expect(projectModalSource).toContain('class="tpl-name-input tpl-rename-input"')
    expect(projectModalSource).not.toContain('class="rename-sizer"')
    expect(styleDeclarations('.tpl-name-input').flex).toBe('1')
    expect(styleDeclarations('.tpl-rename-input')['min-width']).toBe('0')
  })
})
