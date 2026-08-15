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
  { name: '玻璃悬停表面', variable: '--surface-glass-hover', category: 'semantic', type: 'color', description: '所有玻璃组件统一的悬停亮色表面。' },
  { name: '玻璃悬停边界', variable: '--border-hover', category: 'semantic', type: 'color', description: '所有玻璃组件统一的悬停边界高光。' },
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
  { name: '紫色 500', variable: '--palette-purple-500', category: 'primitive', type: 'color', description: '主品牌紫色。' },
  { name: '紫色 400', variable: '--palette-purple-400', category: 'primitive', type: 'color', description: '品牌紫色高亮层。' },
  { name: '粉色 400', variable: '--palette-pink-400', category: 'primitive', type: 'color', description: '暖色辅助强调。' },
  { name: '青色 400', variable: '--palette-cyan-400', category: 'primitive', type: 'color', description: '冷色辅助强调。' },
  { name: '灰色 050', variable: '--palette-gray-050', category: 'primitive', type: 'color', description: '最浅灰阶。' },
  { name: '灰色 100', variable: '--palette-gray-100', category: 'primitive', type: 'color', description: '浅灰阶。' },
  { name: '灰色 300', variable: '--palette-gray-300', category: 'primitive', type: 'color', description: '边界与弱化灰阶。' },
  { name: '灰色 900', variable: '--palette-gray-900', category: 'primitive', type: 'color', description: '深色内容灰阶。' },
  { name: '白色透明度 08', variable: '--alpha-white-08', category: 'primitive', type: 'color', description: '浅色叠层透明度。' },
  { name: '白色透明度 38', variable: '--alpha-white-38', category: 'primitive', type: 'color', description: '浅色玻璃透明度。' },
  { name: '白色透明度 56', variable: '--alpha-white-56', category: 'primitive', type: 'color', description: '浅色表面透明度。' },
  { name: '白色透明度 70', variable: '--alpha-white-70', category: 'primitive', type: 'color', description: '浅色高可见表面透明度。' },
  { name: '白色透明度 76', variable: '--alpha-white-76', category: 'primitive', type: 'color', description: '浅色边界透明度。' },
  { name: '黑色透明度 08', variable: '--alpha-black-08', category: 'primitive', type: 'color', description: '深色遮罩透明度。' },
  { name: '静止阴影', variable: '--shadow-rest', category: 'primitive', type: 'shadow', description: '普通表面静止态。' },
  { name: '悬停阴影', variable: '--shadow-hover', category: 'primitive', type: 'shadow', description: '普通 UI hover 态。' },
  { name: '玻璃卡片悬停阴影', variable: '--glass-card-shadow-hover', category: 'component', type: 'shadow', description: 'Glass 卡片统一的悬停阴影。' },
  { name: '默认过渡', variable: '--motion-default', category: 'motion', type: 'duration', description: '普通 UI 过渡时长。' },
  { name: '导航分割线', variable: '--divider-line', category: 'component', type: 'other', description: '导航栏与页面章节共用的主题分割线。' },
  { name: '画布点阵', variable: '--canvas-dot-color', category: 'canvas', type: 'color', description: '画布点阵视觉，不含 camera 算法。' },
]
