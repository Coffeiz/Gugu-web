export type TokenCategory = 'primitive' | 'semantic' | 'component' | 'motion' | 'canvas'
export type TokenType = 'color' | 'size' | 'shadow' | 'font' | 'duration' | 'other'

export interface DesignToken {
  name: string
  variable: string
  category: TokenCategory
  type: TokenType
  description: string
}

export const tokenCatalog: DesignToken[] = [
  { name: '页面表面', variable: '--surface-page', category: 'semantic', type: 'color', description: '应用根页面背景。' },
  { name: '玻璃表面', variable: '--surface-glass', category: 'semantic', type: 'color', description: '主应用玻璃面板。' },
  { name: '主要文字', variable: '--content-primary', category: 'semantic', type: 'color', description: '正文与主要标题。' },
  { name: '次要文字', variable: '--content-secondary', category: 'semantic', type: 'color', description: '辅助信息与弱化标签。' },
  { name: '主色', variable: '--action-primary', category: 'semantic', type: 'color', description: '主要操作与强调色。' },
  { name: '成功状态', variable: '--status-success', category: 'semantic', type: 'color', description: '成功、完成状态。' },
  { name: '间距 1', variable: '--space-1', category: 'primitive', type: 'size', description: '最小间距档位。' },
  { name: '间距 2', variable: '--space-2', category: 'primitive', type: 'size', description: '紧凑控件间距。' },
  { name: '间距 3', variable: '--space-3', category: 'primitive', type: 'size', description: '普通组件间距。' },
  { name: '间距 4', variable: '--space-4', category: 'primitive', type: 'size', description: '页面与大面板间距。' },
  { name: '字号 XS', variable: '--font-size-xs', category: 'primitive', type: 'font', description: '徽标与极小辅助信息。' },
  { name: '字号 SM', variable: '--font-size-sm', category: 'primitive', type: 'font', description: '辅助信息。' },
  { name: '字号 MD', variable: '--font-size-md', category: 'primitive', type: 'font', description: '正文默认字号。' },
  { name: '字号 LG', variable: '--font-size-lg', category: 'primitive', type: 'font', description: '标题与卡片名称。' },
  { name: '圆角 XS', variable: '--radius-xs', category: 'primitive', type: 'size', description: '小图标和紧凑控件。' },
  { name: '圆角 SM', variable: '--radius-sm', category: 'primitive', type: 'size', description: '输入框和小控件。' },
  { name: '圆角 MD', variable: '--radius-md', category: 'primitive', type: 'size', description: '普通卡片与弹窗。' },
  { name: '圆角 LG', variable: '--radius-lg', category: 'primitive', type: 'size', description: '页面大面板。' },
  { name: '静止阴影', variable: '--shadow-rest', category: 'primitive', type: 'shadow', description: '普通表面静止态。' },
  { name: '悬停阴影', variable: '--shadow-hover', category: 'primitive', type: 'shadow', description: '普通 UI hover 态。' },
  { name: '默认过渡', variable: '--motion-default', category: 'motion', type: 'duration', description: '普通 UI 过渡时长。' },
  { name: '画布点阵', variable: '--canvas-dot-color', category: 'canvas', type: 'color', description: '画布点阵视觉，不含 camera 算法。' },
]
