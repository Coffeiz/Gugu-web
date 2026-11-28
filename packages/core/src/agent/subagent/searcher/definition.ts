export const searcherDefinition = {
  id: 'builtin:searcher',
  name: 'Searcher',
  description: '适合委派多文件查找与版本比对、网页资料研究和多来源事实核验。复杂问题优先按不同子问题或证据方向拆分并行任务，每项任务负责一个独立方向，避免同一方向重复搜索或读取。可在授权范围内定位文件、读取关键章节，或查找并核对官方文档和其他一手来源。交付可复核的研究报告，包含结论、关键摘录或摘要、文件路径或引用、网页直达链接、证据取舍理由，以及适用条件和未确认事项。',
  allowedParentAgentIds: ['builtin:main'],
  toolNames: ['global_search', 'web_search', 'http_get'],
  model: 'inherit',
} as const
