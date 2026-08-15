<template>
  <div class="design-page">
    <header class="design-hero">
      <div class="hero-copy">
        <div class="hero-title-row">
          <span class="eyebrow">GUGU · DESIGN</span>
          <h1>Design Tokens</h1>
        </div>
        <p>Glass / V2 × Light / Dark · 页面与样板只消费公开 Semantic / Component tokens。</p>
      </div>
      <ThemeSwitcher
        :model-value="preference"
        :family="family"
        @update:model-value="setTheme"
        @update:family="setFamily"
      />
    </header>

    <main class="design-content">
      <section class="design-section product-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">01 · PRODUCT SAMPLE</span>
            <h2>真实项目页样板</h2>
            <p>对齐 Projects 的 Sidebar、低存在感 Topbar、项目色卡片与真实咕咕球。点击咕咕球先打开 360 × 360 小窗，再由窗口按钮展开 / 收起。</p>
          </div>
          <span class="state-badge">{{ family.toUpperCase() }} · {{ resolved.toUpperCase() }}</span>
        </div>

        <div class="product-frame">
          <aside class="sample-sidebar">
            <div class="sample-logo">
              <span class="sample-logo-icon"><BirdIcon :size="19" /></span>
              <strong>咕咕</strong>
            </div>
            <nav class="sample-nav">
              <div class="sample-divider" />
              <span class="sample-nav-label">工作台</span>
              <button class="sample-nav-item active"><PhStack :size="14" weight="bold" />项目<span class="nav-count">4</span></button>
              <button class="sample-nav-item"><PhCalendarBlank :size="14" weight="bold" />日历</button>
              <button class="sample-nav-item"><PhAlarm :size="14" weight="bold" />定时任务</button>
              <button class="sample-nav-item"><PhGraph :size="14" weight="bold" />思维</button>
              <div class="sample-divider" />
              <span class="sample-nav-label">资源</span>
              <button class="sample-nav-item"><PhFolder :size="14" weight="bold" />文件库</button>
              <button class="sample-nav-item muted"><PhAddressBook :size="14" weight="bold" />客户<span class="soon">咕了</span></button>
            </nav>
            <div class="sample-user">
              <span class="sample-avatar">C</span>
              <div><strong>Coffeiz</strong><small>创作者</small></div>
            </div>
          </aside>

          <div class="sample-main">
            <header class="sample-topbar">
              <div class="sample-title"><h3>项目</h3><span>2026年8月15日 · 星期六</span></div>
              <div class="sample-search"><PhMagnifyingGlass :size="14" /><span>搜索项目、文件、日程、客户…</span><kbd>⌘ K</kbd></div>
              <button class="sample-ghost"><PhUploadSimple :size="13" weight="bold" />上传文件</button>
              <button class="sample-primary"><PhPlus :size="13" weight="bold" />新建项目</button>
            </header>

            <div class="sample-board">
              <div v-for="column in projectColumns" :key="column.title" class="project-column">
                <header class="column-heading"><span class="column-dot" :style="{ background: column.dot }" /><strong>{{ column.title }}</strong><em>{{ column.cards.length }}</em></header>
                <article
                  v-for="card in column.cards"
                  :key="card.name"
                  class="sample-project-card"
                  :style="{ '--project-color': card.color }"
                >
                  <div class="card-copy">
                    <div class="card-name-row"><strong>{{ card.name }}</strong><span class="stars">{{ card.stars }}</span></div>
                    <div class="card-meta"><span>{{ card.client }}</span><span>{{ card.stage }}</span></div>
                    <div class="card-footer"><span><PhCalendarBlank :size="10" />{{ card.date }}</span><b>{{ card.progress }}%</b></div>
                    <div class="progress-track"><i :style="{ width: card.progress + '%' }" /></div>
                  </div>
                </article>
                <button class="add-project"><PhPlus :size="12" /> 添加项目</button>
              </div>
            </div>
          </div>

          <button class="sample-gugu-fab" :class="{ opened: chatOpen }" title="打开 GuguChat 小窗" @click="chatOpen = true">
            <BirdIcon :size="22" />
          </button>
          <GuguChatMock :open="chatOpen" @close="chatOpen = false" />
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">02 · FOUNDATIONS</span>
            <h2>颜色、字体与空间</h2>
            <p>参考 Mafuyu：Design 页只展示可直接使用的简洁语义名。Palette / Iris / Pearl 仍可作为主题内部实现，但不再作为组件 API。</p>
          </div>
        </div>

        <div class="subsection first-subsection">
          <div class="subheading"><h3>System color</h3><p>公开颜色词汇保持简单，换主题时由 Semantic 层重新映射。</p></div>
          <div class="token-grid color-grid">
            <article v-for="token in systemColors" :key="token.name" class="token-card color-card">
              <div class="color-swatch" :style="{ background: `var(${token.name})` }" />
              <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.note }}</span></div>
            </article>
          </div>
        </div>

        <div class="subsection">
          <div class="subheading"><h3>Project color</h3><p>项目、日历、画布的内容色保持身份，不随主题改写。</p></div>
          <div class="token-grid color-grid compact-colors">
            <article v-for="token in projectColors" :key="token.name" class="token-card color-card">
              <div class="color-swatch" :style="{ background: `var(${token.name})` }" />
              <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code></div>
            </article>
          </div>
        </div>

        <div class="foundation-split">
          <div class="foundation-panel">
            <div class="subheading"><h3>Typography · 5</h3><p>全局只有五个字号档位。</p></div>
            <div class="type-list">
              <div v-for="row in typeScale" :key="row.token" class="type-row">
                <span class="type-sample" :style="{ fontSize: `var(${row.token})`, fontWeight: row.weight }">{{ row.sample }}</span>
                <div class="type-meta"><strong>{{ row.role }}</strong><code>{{ row.token }}</code><small>{{ row.size }} · {{ row.weight }}</small></div>
              </div>
            </div>
          </div>

          <div class="foundation-panel">
            <div class="subheading"><h3>Spacing · 5</h3><p>4 / 8 / 12 / 16 / 24，旧数字令牌只做兼容 alias。</p></div>
            <div class="space-list">
              <div v-for="item in spacingScale" :key="item.token" class="space-row"><code>{{ item.token }}</code><span class="space-bar" :style="{ width: `var(${item.token})` }" /><em>{{ item.value }}</em></div>
            </div>
            <div class="radius-title"><h3>Radius · 5</h3><p>四个几何圆角 + pill。</p></div>
            <div class="radius-row">
              <div v-for="item in radiusScale" :key="item.token" class="radius-item"><span :style="{ borderRadius: `var(${item.token})` }" /><code>{{ item.token }}</code><small>{{ item.value }}</small></div>
            </div>
          </div>
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">03 · SEMANTIC TOKENS</span>
            <h2>角色不是颜色表</h2>
            <p>每个 Semantic token 都展示真实使用模板；组件只消费角色，不判断 Glass / V2。</p>
          </div>
        </div>

        <div class="semantic-groups">
          <article v-for="group in semanticGroups" :key="group.title" class="semantic-group">
            <header><div><h3>{{ group.title }}</h3><p>{{ group.description }}</p></div><span>{{ group.tokens.length }} tokens</span></header>
            <div class="semantic-grid">
              <div v-for="token in group.tokens" :key="token.name" class="token-card semantic-card">
                <div class="semantic-demo">
                  <div v-if="token.demo === 'surface'" class="surface-demo" :style="{ background: `var(${token.name})` }"><span>Surface</span></div>
                  <div v-else-if="token.demo === 'text'" class="text-demo" :style="{ color: `var(${token.name})` }">咕咕正在整理项目</div>
                  <div v-else-if="token.demo === 'border'" class="border-demo" :style="{ borderColor: `var(${token.name})` }"><span>Input / Card edge</span></div>
                  <button v-else-if="token.demo === 'action'" class="action-demo" :style="{ background: `var(${token.name})` }">新建项目</button>
                  <span v-else class="status-demo" :style="{ color: `var(${token.name})`, background: `color-mix(in srgb,var(${token.name}) 14%,transparent)` }"><i :style="{ background: `var(${token.name})` }" />{{ token.usage }}</span>
                </div>
                <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.usage }}</span></div>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">04 · ELEVATION</span>
            <h2>用真实对象定义层级</h2>
            <p>四级 Elevation 直接绑定 Card rest、Card hover、Popup 与 GuguChat window。</p>
          </div>
        </div>
        <div class="elevation-grid">
          <article class="elevation-case">
            <div class="mini-project" style="--project-color:var(--project-lilac)"><strong>项目卡 · Rest</strong><span>角色设定 · 42%</span></div>
            <div class="case-meta"><strong>Card rest</strong><code>--elevation-card</code><span>普通项目 / 文件卡</span></div>
          </article>
          <article class="elevation-case">
            <div class="mini-project hover-case" style="--project-color:var(--project-sky)"><strong>项目卡 · Hover</strong><span>画册排版 · 68%</span></div>
            <div class="case-meta"><strong>Card hover</strong><code>--elevation-card-hover</code><span>悬停抬起</span></div>
          </article>
          <article class="elevation-case">
            <div class="mini-popup"><strong>当前阶段</strong><span>✓ 草图确认</span><span>○ 线稿整理</span><button>＋ 添加待办</button></div>
            <div class="case-meta"><strong>Popup</strong><code>--elevation-popup</code><span>搜索 / 菜单 / 待办弹层</span></div>
          </article>
          <article class="elevation-case">
            <div class="mini-chat"><span class="mini-chat-avatar"><BirdIcon :size="15" /></span><div><strong>GuguChat</strong><small>Window level</small></div></div>
            <div class="case-meta"><strong>Window</strong><code>--elevation-window</code><span>聊天 / 浮动窗口</span></div>
          </article>
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading"><div><span class="section-kicker">05 · COMPONENT CONTRACTS</span><h2>真实组件令牌</h2><p>Semantic role 组合成产品对象；业务组件不重复透明度、阴影与品牌色字面量。</p></div></div>
        <div class="component-strip">
          <div class="contract-card"><span class="contract-icon"><PhSidebarSimple :size="18" /></span><div><strong>Sidebar</strong><code>--sidebar-*</code><small>背景 / 导航 / 用户卡</small></div></div>
          <div class="contract-card"><span class="contract-icon"><PhBrowser :size="18" /></span><div><strong>Topbar</strong><code>--topbar-*</code><small>低存在感层</small></div></div>
          <div class="contract-card"><span class="contract-icon"><PhStack :size="18" /></span><div><strong>Project Card</strong><code>--project-card-*</code><small>保留内容色渐变</small></div></div>
          <div class="contract-card"><span class="contract-icon gugu-icon"><BirdIcon :size="18" /></span><div><strong>Gugu</strong><code>--gugu-*</code><small>FAB / Chat window</small></div></div>
        </div>
      </section>

      <section class="design-section index-section">
        <div class="section-heading"><div><span class="section-kicker">06 · TOKEN INDEX</span><h2>统一索引卡</h2><p>Index 与上面的颜色卡共用同一套卡片、边框、字号和圆角。</p></div></div>
        <div class="index-groups">
          <article v-for="group in tokenIndex" :key="group.title" class="index-group">
            <header><h3>{{ group.title }}</h3><span>{{ group.items.length }}</span></header>
            <div class="index-grid">
              <div v-for="item in group.items" :key="item" class="token-card index-card"><code>{{ item }}</code><span class="index-dot" :style="indexDotStyle(item)" /></div>
            </div>
          </article>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { h, ref } from 'vue'
import {
  PhAddressBook, PhAlarm, PhBrowser, PhCalendarBlank, PhFolder, PhGraph, PhMagnifyingGlass,
  PhPlus, PhSidebarSimple, PhStack, PhUploadSimple,
} from '@phosphor-icons/vue'
import { useTheme } from '@/composables/useTheme'
import ThemeSwitcher from './ThemeSwitcher.vue'
import GuguChatMock from './GuguChatMock.vue'

const { preference, resolved, family, setTheme, setFamily } = useTheme()
const chatOpen = ref(false)

const BirdIcon = (props: { size?: number }) => h('svg', {
  width: props.size ?? 18, height: props.size ?? 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
}, [
  h('path', { d: 'M16 7h.01' }), h('path', { d: 'M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20' }),
  h('path', { d: 'M20 7l2 .5-2 .5' }), h('path', { d: 'M10 18v3' }), h('path', { d: 'M14 17.75V21' }),
])

const projectColumns = [
  { title: '待开始', dot: 'var(--project-sand)', cards: [
    { name: '夏日插画', client: '个人创作', stage: '构思', date: '8/18 → 8/25', progress: 18, stars: '★★☆', color: 'var(--project-sand)' },
    { name: '网站作品集', client: 'Coffeiz', stage: '整理素材', date: '8/20 → 9/02', progress: 12, stars: '★☆☆', color: 'var(--project-mauve)' },
  ]},
  { title: '进行中', dot: 'var(--action-primary)', cards: [
    { name: '角色设定', client: '原创项目', stage: '线稿', date: '8/12 → 8/19', progress: 42, stars: '★★★', color: 'var(--project-lilac)' },
    { name: '画册排版', client: '人生对比色', stage: '版式', date: '8/10 → 8/22', progress: 68, stars: '★★☆', color: 'var(--project-sky)' },
    { name: '封面设计', client: '委托', stage: '配色', date: '8/14 → 8/20', progress: 54, stars: '★★☆', color: 'var(--project-rose)' },
  ]},
  { title: '已完成', dot: 'var(--status-success)', cards: [
    { name: '七月头像稿', client: '委托', stage: '完成', date: '8/06', progress: 100, stars: '★★☆', color: 'var(--project-leaf)' },
    { name: '海报视觉', client: '活动', stage: '完成', date: '8/09', progress: 100, stars: '★☆☆', color: 'var(--project-coral)' },
  ]},
]

const systemColors = [
  { label: 'Primary', name: '--color-primary', note: '主操作 / 品牌动作' },
  { label: 'Text', name: '--color-text', note: '主要内容' },
  { label: 'Muted', name: '--color-muted', note: '次级内容' },
  { label: 'Surface', name: '--color-surface', note: '实体表面' },
  { label: 'Line', name: '--color-line', note: '控件 / 分隔边缘' },
  { label: 'Success', name: '--color-success', note: '完成 / 在线' },
  { label: 'Warning', name: '--color-warning', note: '临期 / 休息' },
  { label: 'Danger', name: '--color-danger', note: '错误 / 删除' },
  { label: 'Info', name: '--color-info', note: '信息提示' },
]
const projectColors = [
  ['Lilac','--project-lilac'],['Rose','--project-rose'],['Sky','--project-sky'],['Leaf','--project-leaf'],
  ['Sand','--project-sand'],['Coral','--project-coral'],['Blue','--project-blue'],['Mauve','--project-mauve'],
].map(([label,name]) => ({ label, name }))

const typeScale = [
  { role: 'Caption', token: '--font-size-xs', size: '11px', weight: 500, sample: '项目阶段 · 刚刚更新' },
  { role: 'Secondary', token: '--font-size-sm', size: '12px', weight: 400, sample: '明天下午留给角色设定' },
  { role: 'Body / Nav', token: '--font-size-md', size: '14px', weight: 500, sample: '咕咕正在整理今天的项目进度。' },
  { role: 'Section', token: '--font-size-lg', size: '16px', weight: 600, sample: 'Semantic Tokens' },
  { role: 'Title', token: '--font-size-xl', size: '20px', weight: 700, sample: 'Design Tokens' },
]
const spacingScale = [
  ['--space-xs','4px'],['--space-sm','8px'],['--space-md','12px'],['--space-lg','16px'],['--space-xl','24px'],
].map(([token,value]) => ({ token, value }))
const radiusScale = [
  ['--radius-xs','6px'],['--radius-sm','10px'],['--radius-md','14px'],['--radius-lg','20px'],['--radius-pill','pill'],
].map(([token,value]) => ({ token, value }))

const semanticGroups = [
  { title: 'Surface', description: '页面、面板、浮层与安静反馈。', tokens: [
    { label:'Page', name:'--surface-page', usage:'App 背景', demo:'surface' }, { label:'Sidebar', name:'--surface-sidebar', usage:'侧栏', demo:'surface' },
    { label:'Raised', name:'--surface-raised', usage:'控件 / 气泡', demo:'surface' }, { label:'Floating', name:'--surface-floating', usage:'Popup / Window', demo:'surface' },
  ]},
  { title: 'Content', description: '文字层级只由角色决定。', tokens: [
    { label:'Primary', name:'--content-primary', usage:'标题 / 正文', demo:'text' }, { label:'Secondary', name:'--content-secondary', usage:'元信息', demo:'text' },
    { label:'Tertiary', name:'--content-tertiary', usage:'提示 / 时间', demo:'text' }, { label:'Disabled', name:'--content-disabled', usage:'不可用', demo:'text' },
  ]},
  { title: 'Border', description: '边框表达层级与交互。', tokens: [
    { label:'Subtle', name:'--border-subtle', usage:'分隔 / 内层边', demo:'border' }, { label:'Default', name:'--border-default', usage:'控件边缘', demo:'border' },
    { label:'Strong', name:'--border-strong', usage:'Glass / Popup', demo:'border' }, { label:'Focus', name:'--border-focus', usage:'键盘焦点', demo:'border' },
  ]},
  { title: 'Action', description: '紫色是动作，不是环境。', tokens: [
    { label:'Primary', name:'--action-primary', usage:'主按钮', demo:'action' }, { label:'Hover', name:'--action-primary-hover', usage:'主操作 hover', demo:'action' },
    { label:'Pressed', name:'--action-primary-pressed', usage:'按下反馈', demo:'action' }, { label:'Selection', name:'--selection-bg', usage:'选中项背景', demo:'surface' },
  ]},
  { title: 'Status', description: '状态色只表达状态。', tokens: [
    { label:'Success', name:'--status-success', usage:'在线 / 完成', demo:'status' }, { label:'Warning', name:'--status-warning', usage:'临期 / 休息', demo:'status' },
    { label:'Danger', name:'--status-danger', usage:'错误 / 删除', demo:'status' }, { label:'Info', name:'--status-info', usage:'信息提示', demo:'status' },
  ]},
]

const tokenIndex = [
  { title:'Foundations', items:['--font-size-xs','--font-size-sm','--font-size-md','--font-size-lg','--font-size-xl','--space-xs','--space-sm','--space-md','--space-lg','--space-xl','--radius-xs','--radius-sm','--radius-md','--radius-lg','--radius-pill'] },
  { title:'Semantic', items:['--color-primary','--color-text','--color-muted','--color-surface','--surface-floating','--content-primary','--border-subtle','--status-success','--elevation-popup'] },
  { title:'Components', items:['--sidebar-bg','--sidebar-item-active','--topbar-bg','--project-card-shadow','--project-card-sheen-hover','--gugu-fab-bg','--gugu-chat-shadow'] },
]

function indexDotStyle(token: string) {
  const colorLike = /color|surface|content|border|action|status|bg|active/.test(token)
  return colorLike ? { background: `var(${token})` } : { background: 'var(--action-primary)' }
}
</script>

<style scoped>
.design-page { height: 100vh; overflow-y: auto; background: var(--surface-page); color: var(--content-primary); font-family: var(--font-sans); font-synthesis: none; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }

/* Compact sticky bar: information stays available without taking over the viewport. */
.design-hero { position: sticky; top: 0; z-index: 50; min-height: 58px; display: flex; align-items: center; gap: var(--space-xl); padding: var(--space-sm) clamp(var(--space-lg),3vw,var(--space-xl)); background: color-mix(in srgb,var(--surface-glass) 88%,transparent); border-bottom: 1px solid var(--border-strong); box-shadow: inset 0 1px 0 var(--border-highlight), var(--elevation-card); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
.hero-copy { min-width: 0; max-width: 760px; }
.hero-title-row { display: flex; align-items: baseline; gap: var(--space-sm); }
.eyebrow, .section-kicker { display: block; color: var(--content-tertiary); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); letter-spacing: var(--tracking-label); }
.hero-copy h1 { font-size: var(--font-size-xl); line-height: var(--line-height-tight); font-weight: var(--font-weight-bold); letter-spacing: -.02em; }
.hero-copy p { margin-top: var(--space-xs); overflow: hidden; color: var(--content-secondary); font-size: var(--font-size-xs); line-height: var(--line-height-ui); white-space: nowrap; text-overflow: ellipsis; }

.design-content { width: min(1440px,100%); margin: 0 auto; padding: var(--space-xl) clamp(var(--space-lg),4vw,56px) 72px; }
.design-section { position: relative; margin-bottom: var(--design-section-gap); padding: var(--space-xl); background: var(--design-section-bg); border: 1px solid var(--design-section-border); border-radius: var(--design-section-radius); box-shadow: var(--design-section-shadow), inset 0 1px 0 var(--design-section-highlight); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
.section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-xl); margin-bottom: var(--space-lg); }
.section-heading h2 { margin-top: var(--space-xs); font-size: var(--font-size-lg); font-weight: var(--font-weight-semibold); letter-spacing: -.01em; }
.section-heading p { max-width: 800px; margin-top: var(--space-xs); color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); }
.state-badge { flex-shrink: 0; padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-pill); color: var(--selection-fg); background: var(--selection-bg); border: 1px solid var(--border-subtle); font: var(--font-weight-semibold) var(--font-size-xs) var(--font-sans); letter-spacing: .04em; }

.subsection { margin-top: var(--space-xl); }
.first-subsection { margin-top: 0; }
.subheading { display: flex; align-items: baseline; gap: var(--space-md); margin-bottom: var(--space-md); }
.subheading h3, .radius-title h3 { font-size: var(--font-size-md); font-weight: var(--font-weight-semibold); }
.subheading p, .radius-title p { color: var(--content-tertiary); font-size: var(--font-size-xs); }
.token-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--design-grid-gap); }
.token-card { min-width: 0; background: var(--design-card-bg); border: 1px solid var(--design-card-border); border-radius: var(--design-card-radius); box-shadow: var(--elevation-card); }
.color-card { overflow: hidden; }
.color-swatch { height: 76px; border-bottom: 1px solid var(--border-hairline); }
.token-meta { padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-xs); }
.token-meta strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.token-meta code, .case-meta code, .contract-card code, .index-card code, .type-meta code, .space-row code, .radius-item code { color: var(--selection-fg); font: var(--font-size-xs)/var(--line-height-ui) var(--font-mono); overflow-wrap: anywhere; }
.token-meta span, .case-meta span { color: var(--content-tertiary); font-size: var(--font-size-xs); line-height: var(--line-height-ui); }
.compact-colors .color-swatch { height: 56px; }

.foundation-split { display: grid; grid-template-columns: minmax(0,1.15fr) minmax(0,.85fr); gap: var(--design-grid-gap); margin-top: var(--space-xl); }
.foundation-panel { padding: var(--space-lg); background: var(--surface-soft); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
.type-list { display: flex; flex-direction: column; }
.type-row { min-height: 62px; display: grid; grid-template-columns: minmax(0,1fr) 190px; align-items: center; gap: var(--space-lg); border-top: 1px solid var(--border-hairline); }
.type-row:first-child { border-top: 0; }
.type-sample { min-width: 0; line-height: var(--line-height-ui); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.type-meta { display: grid; gap: var(--space-xs); }
.type-meta strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.type-meta small, .radius-item small { color: var(--content-tertiary); font-size: var(--font-size-xs); }
.space-list { display: flex; flex-direction: column; gap: var(--space-sm); }
.space-row { display: grid; grid-template-columns: 110px 1fr 38px; align-items: center; gap: var(--space-sm); min-height: 22px; }
.space-bar { display: block; min-width: 4px; height: 7px; border-radius: var(--radius-pill); background: var(--action-primary); }
.space-row em { color: var(--content-tertiary); font: normal var(--font-size-xs) var(--font-mono); }
.radius-title { display: flex; align-items: baseline; gap: var(--space-md); margin-top: var(--space-xl); padding-top: var(--space-lg); border-top: 1px solid var(--border-hairline); }
.radius-row { display: grid; grid-template-columns: repeat(5,1fr); gap: var(--space-sm); margin-top: var(--space-md); }
.radius-item { min-width: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
.radius-item > span { width: 42px; height: 32px; background: var(--selection-bg); border: 1px solid var(--border-default); }

.semantic-groups { display: flex; flex-direction: column; gap: var(--space-md); }
.semantic-group { padding: var(--space-lg); background: var(--surface-soft); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
.semantic-group > header { display: flex; justify-content: space-between; gap: var(--space-lg); margin-bottom: var(--space-md); }
.semantic-group > header h3 { font-size: var(--font-size-md); font-weight: var(--font-weight-semibold); }
.semantic-group > header p { margin-top: var(--space-xs); color: var(--content-tertiary); font-size: var(--font-size-xs); }
.semantic-group > header > span { color: var(--content-tertiary); font: var(--font-size-xs) var(--font-mono); }
.semantic-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--space-sm); }
.semantic-card { overflow: hidden; }
.semantic-demo { height: 78px; padding: var(--space-md); display: flex; align-items: center; justify-content: center; border-bottom: 1px solid var(--border-hairline); background: var(--surface-soft); }
.surface-demo { width: 100%; height: 100%; display: grid; place-items: center; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); color: var(--content-secondary); font-size: var(--font-size-xs); }
.text-demo { width: 100%; font-size: var(--font-size-md); font-weight: var(--font-weight-medium); }
.border-demo { width: 100%; height: 40px; display: flex; align-items: center; padding: 0 var(--space-sm); border: 1px solid; border-radius: var(--radius-sm); color: var(--content-tertiary); background: var(--surface-raised); font-size: var(--font-size-xs); }
.action-demo { height: 34px; padding: 0 var(--space-md); border: 0; border-radius: var(--radius-sm); color: var(--content-on-accent); font: var(--font-weight-medium) var(--font-size-sm) var(--font-sans); box-shadow: var(--elevation-card); }
.status-demo { display: inline-flex; align-items: center; gap: var(--space-xs); padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-pill); font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); }
.status-demo i { width: 6px; height: 6px; border-radius: 50%; }

.elevation-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--design-grid-gap); }
.elevation-case { min-height: 230px; padding: var(--space-lg); display: flex; flex-direction: column; justify-content: center; gap: var(--space-lg); background: var(--surface-soft); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); }
.mini-project { position: relative; overflow: hidden; min-height: 88px; padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-sm); border-radius: var(--project-card-radius); border: 1px solid var(--project-card-border); background: linear-gradient(to right,var(--project-card-gradient-start) 0%,var(--project-card-gradient-end) 40%),var(--project-color); box-shadow: var(--project-card-shadow); }
.mini-project::after { content:''; position:absolute; inset:0; background:var(--project-card-sheen-rest); box-shadow:inset 0 1px 0 var(--project-card-highlight-rest); pointer-events:none; }
.mini-project strong { position: relative; z-index: 1; font-size: var(--font-size-md); font-weight: var(--font-weight-medium); }
.mini-project span { position: relative; z-index: 1; color: var(--content-secondary); font-size: var(--font-size-sm); }
.hover-case { transform: translateY(-2px); box-shadow: var(--project-card-hover-shadow); }
.hover-case::after { background: var(--project-card-sheen-hover); box-shadow: inset 0 1px 0 var(--project-card-highlight-hover); }
.mini-popup { width: 190px; align-self: center; padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-sm); border-radius: var(--popup-radius); background: var(--popup-background); border: 1px solid var(--popup-border); box-shadow: var(--elevation-popup); }
.mini-popup strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.mini-popup span { color: var(--content-secondary); font-size: var(--font-size-sm); }
.mini-popup button { padding: var(--space-xs); border: 0; border-radius: var(--radius-xs); color: var(--action-primary); background: var(--action-soft); font: var(--font-size-xs) var(--font-sans); }
.mini-chat { width: 190px; height: 90px; align-self: center; display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-md); border-radius: var(--gugu-chat-radius); background: var(--gugu-chat-bg); border: 1px solid var(--gugu-chat-border); box-shadow: var(--gugu-chat-shadow); }
.mini-chat-avatar { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; color: white; background: var(--gugu-fab-bg); }
.mini-chat div, .case-meta { display: flex; flex-direction: column; gap: var(--space-xs); }
.mini-chat strong, .case-meta strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.mini-chat small { color: var(--content-tertiary); font-size: var(--font-size-xs); }

.component-strip { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--design-grid-gap); }
.contract-card { min-height: 94px; display: flex; align-items: center; gap: var(--space-md); padding: var(--space-lg); background: var(--design-card-bg); border: 1px solid var(--design-card-border); border-radius: var(--design-card-radius); box-shadow: var(--elevation-card); }
.contract-icon { width: 38px; height: 38px; display: grid; place-items: center; flex-shrink: 0; border-radius: var(--radius-sm); color: var(--action-primary); background: var(--action-soft); }
.gugu-icon { color: white; background: var(--gugu-fab-bg); }
.contract-card div { min-width: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
.contract-card strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.contract-card small { color: var(--content-tertiary); font-size: var(--font-size-xs); }

.index-groups { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: var(--design-grid-gap); }
.index-group { padding: var(--space-md); border-radius: var(--radius-md); background: var(--surface-soft); border: 1px solid var(--border-subtle); }
.index-group header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-sm); }
.index-group h3 { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.index-group header span { color: var(--content-tertiary); font: var(--font-size-xs) var(--font-mono); }
.index-grid { display: flex; flex-direction: column; gap: var(--space-xs); }
.index-card { min-height: 38px; padding: var(--space-sm); display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); box-shadow: none; }
.index-dot { width: 18px; height: 18px; flex-shrink: 0; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); }

/* Product sample */
.product-frame { position: relative; height: 620px; overflow: hidden; display: flex; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-page); box-shadow: var(--elevation-popup); }
.sample-sidebar { width: var(--sidebar-width); height: 100%; flex-shrink: 0; display: flex; flex-direction: column; padding: var(--space-xl) var(--space-md); background: var(--sidebar-bg); border-right: 1px solid var(--sidebar-border); box-shadow: inset -1px 0 0 var(--sidebar-highlight); backdrop-filter: var(--popup-blur); -webkit-backdrop-filter: var(--popup-blur); }
.sample-logo { display: flex; align-items: center; justify-content: center; gap: var(--space-sm); padding: 0 var(--space-sm); margin-bottom: var(--space-lg); }
.sample-logo-icon { width: 34px; height: 34px; display: grid; place-items: center; border-radius: var(--radius-sm); color: white; background: var(--brand-gradient); box-shadow: inset 0 1px 0 color-mix(in srgb,white 40%,transparent); }
.sample-logo strong { font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); }
.sample-nav { flex: 1; display: flex; flex-direction: column; gap: var(--space-xs); }
.sample-divider { height: 1px; margin: var(--space-xs); background: var(--divider-line); }
.sample-nav-label { padding: 0 var(--space-sm); margin-bottom: var(--space-xs); color: var(--sidebar-label-fg); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
.sample-nav-item { width: 100%; display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--sidebar-item-fg); background: transparent; font: var(--font-weight-regular) var(--font-size-md) var(--font-sans); text-align: left; }
.sample-nav-item.active { color: var(--sidebar-item-active-fg); background: var(--sidebar-item-active); border-color: var(--sidebar-item-active-border); box-shadow: var(--sidebar-item-active-shadow); font-weight: var(--font-weight-semibold); }
.sample-nav-item.muted { color: var(--content-tertiary); }
.nav-count { margin-left: auto; padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-pill); color: white; background: color-mix(in srgb,var(--action-primary) 42%,transparent); font-size: var(--font-size-xs); }
.soon { margin-left: auto; color: var(--content-tertiary); font-size: var(--font-size-xs); }
.sample-user { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm); border-radius: var(--radius-md); background: var(--sidebar-user-bg); border: 1px solid var(--sidebar-user-border); box-shadow: var(--sidebar-item-active-shadow); }
.sample-avatar { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; color: white; background: linear-gradient(135deg,var(--action-primary),var(--status-info)); font-size: var(--font-size-md); font-weight: var(--font-weight-bold); }
.sample-user div { min-width: 0; display: flex; flex-direction: column; }
.sample-user strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.sample-user small { color: var(--content-tertiary); font-size: var(--font-size-xs); }
.sample-main { position: relative; flex: 1; min-width: 0; overflow: hidden; }
.sample-topbar { position: absolute; top: var(--space-lg); left: var(--space-lg); right: var(--space-lg); z-index: 5; height: 52px; display: flex; align-items: center; gap: var(--space-md); padding: 0 var(--space-lg); border: 1px solid var(--topbar-border); border-radius: var(--radius-md); background: var(--topbar-bg); box-shadow: var(--topbar-shadow); backdrop-filter: blur(var(--topbar-blur)); -webkit-backdrop-filter: blur(var(--topbar-blur)); }
.sample-title { flex-shrink: 0; display: flex; align-items: baseline; gap: var(--space-sm); }
.sample-title h3 { font-size: var(--font-size-lg); line-height: var(--line-height-tight); font-weight: var(--font-weight-bold); }
.sample-title span { color: var(--content-secondary); font-size: var(--font-size-xs); }
.sample-search { min-width: 180px; max-width: 310px; height: var(--control-sm); margin-left: auto; display: flex; align-items: center; gap: var(--space-sm); padding: 0 var(--space-sm); border-radius: var(--control-radius); color: var(--content-secondary); background: var(--control-bg); border: 1px solid var(--control-border); font-size: var(--font-size-xs); }
.sample-search span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.sample-search kbd { margin-left: auto; padding: 0 var(--space-xs); border: 1px solid var(--border-subtle); border-radius: var(--radius-xs); color: var(--content-tertiary); background: var(--surface-soft); font: var(--font-size-xs) var(--font-sans); }
.sample-ghost, .sample-primary { height: var(--control-sm); display: inline-flex; align-items: center; gap: var(--space-xs); padding: 0 var(--space-sm); border-radius: var(--control-radius); font: var(--font-weight-medium) var(--font-size-xs) var(--font-sans); white-space: nowrap; }
.sample-ghost { color: var(--content-secondary); background: var(--control-bg); border: 1px solid var(--control-border); box-shadow: inset 0 1px 0 var(--border-highlight); }
.sample-primary { color: var(--content-on-accent); background: var(--action-primary); border: 1px solid transparent; box-shadow: var(--elevation-card); }
.sample-board { height: 100%; padding: 84px var(--space-xl) var(--space-xl); display: grid; grid-template-columns: repeat(3,minmax(190px,1fr)); gap: var(--space-md); overflow: hidden; }
.project-column { min-width: 0; padding: var(--space-sm); display: flex; flex-direction: column; gap: var(--space-sm); border-radius: var(--radius-md); background: var(--surface-column); }
.column-heading { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-xs); }
.column-heading strong { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.column-heading em { margin-left: auto; color: var(--content-tertiary); font: normal var(--font-size-xs) var(--font-mono); }
.column-dot { width: 7px; height: 7px; border-radius: 50%; }
.sample-project-card { position: relative; overflow: hidden; min-height: 104px; border: 1px solid var(--project-card-border); border-radius: var(--project-card-radius); background: linear-gradient(to right,var(--project-card-gradient-start) 0%,var(--project-card-gradient-end) 40%),var(--project-color); box-shadow: var(--project-card-shadow); transition: transform var(--motion-fast), border-color var(--motion-fast), box-shadow var(--motion-fast); }
.sample-project-card::before { content:''; position:absolute; inset:0; background:var(--project-card-sheen-rest); box-shadow:inset 0 1px 0 var(--project-card-highlight-rest); pointer-events:none; }
.sample-project-card:hover { transform: translateY(-2px); border-color: var(--project-card-hover-border); box-shadow: var(--project-card-hover-shadow); }
.sample-project-card:hover::before { background: var(--project-card-sheen-hover); box-shadow: inset 0 1px 0 var(--project-card-highlight-hover); }
.card-copy { position: relative; z-index: 1; padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-sm); }
.card-name-row, .card-meta, .card-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs); }
.card-name-row strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-md); font-weight: var(--font-weight-medium); }
.stars { color: var(--action-primary); font-size: var(--font-size-xs); letter-spacing: -.08em; }
.card-meta, .card-footer { color: var(--content-secondary); font-size: var(--font-size-xs); }
.card-footer > span { display: inline-flex; align-items: center; gap: var(--space-xs); }
.card-footer b { color: var(--content-tertiary); font: var(--font-weight-semibold) var(--font-size-xs) var(--font-sans); }
.progress-track { height: 3px; overflow: hidden; border-radius: var(--radius-pill); background: var(--surface-soft-hover); }
.progress-track i { display: block; height: 100%; border-radius: inherit; background: var(--project-color); }
.add-project { height: 30px; display: flex; align-items: center; justify-content: center; gap: var(--space-xs); border: 1px dashed var(--border-subtle); border-radius: var(--radius-sm); color: var(--content-tertiary); background: transparent; font: var(--font-size-xs) var(--font-sans); }
.sample-gugu-fab { position: absolute; right: var(--floating-edge); bottom: var(--floating-edge); z-index: 16; width: var(--gugu-fab-size); height: var(--gugu-fab-size); display: grid; place-items: center; border: 1px solid var(--gugu-fab-border); border-radius: 50%; color: white; background: var(--gugu-fab-bg); box-shadow: var(--gugu-fab-shadow); cursor: pointer; transition: transform var(--motion-fast),box-shadow var(--motion-fast),opacity var(--motion-fast); }
.sample-gugu-fab:hover { transform: scale(1.08); box-shadow: var(--gugu-fab-hover-shadow); }
.sample-gugu-fab.opened { opacity: 0; pointer-events: none; transform: scale(.9); }

@media (max-width: 1100px) {
  .token-grid,.semantic-grid,.elevation-grid,.component-strip { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .index-groups { grid-template-columns: 1fr; }
  .sample-sidebar { width: 188px; }
  .sample-board { padding-left: var(--space-lg); padding-right: var(--space-lg); }
  .sample-search { display: none; }
}
@media (max-width: 760px) {
  .design-hero { position: relative; min-height: 0; flex-direction: column; align-items: flex-start; }
  .hero-copy p { white-space: normal; }
  .design-content { padding-top: var(--space-lg); }
  .design-section { padding: var(--space-lg); }
  .foundation-split { grid-template-columns: 1fr; }
  .token-grid,.semantic-grid,.elevation-grid,.component-strip { grid-template-columns: 1fr; }
  .sample-sidebar { display: none; }
  .sample-board { grid-template-columns: repeat(3,240px); overflow-x: auto; }
  .sample-topbar { right: var(--space-md); left: var(--space-md); padding: 0 var(--space-md); }
  .sample-title span, .sample-ghost { display:none; }
  .type-row { grid-template-columns: 1fr; padding: var(--space-sm) 0; gap: var(--space-xs); }
  .radius-row { grid-template-columns: repeat(3,1fr); }
}
</style>