<template>
  <div class="design-page">
    <header class="design-hero">
      <div class="hero-copy">
        <span class="eyebrow">GUGU · DESIGN SYSTEM</span>
        <h1>Design Tokens</h1>
        <p>页面本身只使用咕咕真实令牌。Glass / V2 是视觉家族，Light / Dark 是颜色模式；组件只消费同一份 Semantic contract。</p>
      </div>
      <ThemeSwitcher
        :model-value="preference"
        :family="family"
        @update:model-value="setTheme"
        @update:family="setFamily"
      />
    </header>

    <main class="design-content">
      <!-- Product sample --------------------------------------------------- -->
      <section class="design-section product-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">01 · PRODUCT SAMPLE</span>
            <h2>真实项目页样板</h2>
            <p>结构、比例和状态跟随 Projects 页面：220px Sidebar、低存在感 Topbar、三列项目板、原始项目色渐变卡片与真实咕咕球。</p>
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

          <button class="sample-gugu-fab" :class="{ opened: chatOpen }" title="展开 GuguChatMock" @click="chatOpen = !chatOpen">
            <BirdIcon :size="22" />
          </button>
          <GuguChatMock :open="chatOpen" @close="chatOpen = false" />
        </div>
      </section>

      <!-- Foundations ------------------------------------------------------ -->
      <section class="design-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">02 · FOUNDATIONS</span>
            <h2>颜色、字体与空间</h2>
            <p>参考 Mafuyu Design 页的组织方式：同一种卡片语法展示所有基础令牌，不让颜色区、字体区和 Token Index 各长一套样子。</p>
          </div>
        </div>

        <div class="subsection">
          <div class="subheading"><h3>System color</h3><p>系统颜色负责 UI；项目颜色属于内容层，主题不改写它。</p></div>
          <div class="token-grid color-grid">
            <article v-for="token in systemColors" :key="token.name" class="token-card color-card">
              <div class="color-swatch" :style="{ background: `var(${token.name})` }" />
              <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.note }}</span></div>
            </article>
          </div>
        </div>

        <div class="subsection">
          <div class="subheading"><h3>Project color</h3><p>项目、日历、画布共同使用的内容色。它们在 Glass / V2、Light / Dark 中保持身份。</p></div>
          <div class="token-grid color-grid compact-colors">
            <article v-for="token in projectColors" :key="token.name" class="token-card color-card">
              <div class="color-swatch" :style="{ background: `var(${token.name})` }" />
              <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code></div>
            </article>
          </div>
        </div>

        <div class="foundation-split">
          <div class="subsection foundation-panel">
            <div class="subheading"><h3>Typography</h3><p>中文 UI 以系统字体优先，统一到 400 / 500 / 600 / 700 四档。</p></div>
            <div class="type-list">
              <div v-for="row in typeScale" :key="row.token" class="type-row">
                <span class="type-sample" :style="{ fontSize: `var(${row.token})`, fontWeight: row.weight }">{{ row.sample }}</span>
                <div class="type-meta"><strong>{{ row.role }}</strong><code>{{ row.token }}</code><small>{{ row.size }} · {{ row.weight }}</small></div>
              </div>
            </div>
          </div>

          <div class="subsection foundation-panel">
            <div class="subheading"><h3>Spacing & shape</h3><p>沿 4px grid 建立节奏；半步只用于紧凑 UI，不创造新的任意值。</p></div>
            <div class="space-list">
              <div v-for="item in spacingScale" :key="item.token" class="space-row"><code>{{ item.token }}</code><span class="space-bar" :style="{ width: `var(${item.token})` }" /><em>{{ item.value }}</em></div>
            </div>
            <div class="radius-row">
              <div v-for="item in radiusScale" :key="item.token" class="radius-item"><span :style="{ borderRadius: `var(${item.token})` }" /><code>{{ item.token }}</code><small>{{ item.value }}</small></div>
            </div>
          </div>
        </div>
      </section>

      <!-- Semantic --------------------------------------------------------- -->
      <section class="design-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">03 · SEMANTIC TOKENS</span>
            <h2>角色不是颜色表</h2>
            <p>每个 Semantic token 同时展示用途和真实 UI 模板。组件只认这些角色，不判断 Glass / V2。</p>
          </div>
        </div>

        <div class="semantic-groups">
          <article v-for="group in semanticGroups" :key="group.title" class="semantic-group">
            <header><div><h3>{{ group.title }}</h3><p>{{ group.description }}</p></div><span>{{ group.tokens.length }} tokens</span></header>
            <div class="semantic-grid">
              <div v-for="token in group.tokens" :key="token.name" class="token-card semantic-card">
                <div class="semantic-demo" :class="`demo-${token.demo}`">
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

      <!-- Elevation -------------------------------------------------------- -->
      <section class="design-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">04 · ELEVATION</span>
            <h2>用真实对象定义层级</h2>
            <p>不再展示四个空白方块。Elevation 直接绑定咕咕中的 Card rest、Card hover、Popup 与 GuguChat window。</p>
          </div>
        </div>
        <div class="elevation-grid">
          <article class="elevation-case">
            <div class="mini-project" style="--project-color:var(--project-lilac)"><strong>项目卡 · Rest</strong><span>角色设定 · 42%</span></div>
            <div class="case-meta"><strong>Card rest</strong><code>--elevation-card</code><span>普通项目 / 文件卡</span></div>
          </article>
          <article class="elevation-case">
            <div class="mini-project hover-case" style="--project-color:var(--project-sky)"><strong>项目卡 · Hover</strong><span>画册排版 · 68%</span></div>
            <div class="case-meta"><strong>Card hover</strong><code>--elevation-card-hover</code><span>悬停抬起 2px</span></div>
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

      <!-- Component contracts -------------------------------------------- -->
      <section class="design-section">
        <div class="section-heading"><div><span class="section-kicker">05 · COMPONENT CONTRACTS</span><h2>真实组件令牌</h2><p>组件契约把 Semantic role 组合成产品对象；业务组件不应该再重复透明度、阴影和品牌色字面量。</p></div></div>
        <div class="component-strip">
          <div class="contract-card"><span class="contract-icon sidebar-icon"><PhSidebarSimple :size="18" /></span><div><strong>Sidebar</strong><code>--sidebar-*</code><small>背景 / 导航 / 用户卡</small></div></div>
          <div class="contract-card"><span class="contract-icon"><PhBrowser :size="18" /></span><div><strong>Topbar</strong><code>--topbar-*</code><small>低存在感层</small></div></div>
          <div class="contract-card"><span class="contract-icon"><PhStack :size="18" /></span><div><strong>Project Card</strong><code>--project-card-*</code><small>保留内容色渐变</small></div></div>
          <div class="contract-card"><span class="contract-icon gugu-icon"><BirdIcon :size="18" /></span><div><strong>Gugu</strong><code>--gugu-*</code><small>FAB / Chat window</small></div></div>
        </div>
      </section>

      <!-- Token index ------------------------------------------------------ -->
      <section class="design-section index-section">
        <div class="section-heading"><div><span class="section-kicker">06 · TOKEN INDEX</span><h2>同一种索引卡</h2><p>颜色、Semantic、Component 都回到同一套卡片语法，避免 Token Index 自己成为第五套设计。</p></div></div>
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
  { label: 'Glass primary', name: '--palette-purple-500', note: 'Glass brand primitive' },
  { label: 'Glass secondary', name: '--palette-pink-400', note: 'Brand gradient companion' },
  { label: 'Iris 500', name: '--iris-500', note: 'V2 accent primitive' },
  { label: 'Pearl 50', name: '--pearl-50', note: 'V2 light neutral' },
  { label: 'Pearl 900', name: '--pearl-900', note: 'V2 ink neutral' },
  { label: 'Success', name: '--color-green-500', note: 'Status primitive' },
  { label: 'Warning', name: '--color-amber-500', note: 'Status primitive' },
  { label: 'Danger', name: '--color-red-500', note: 'Status primitive' },
]
const projectColors = [
  ['Lilac','--project-lilac'],['Rose','--project-rose'],['Sky','--project-sky'],['Leaf','--project-leaf'],
  ['Sand','--project-sand'],['Coral','--project-coral'],['Blue','--project-blue'],['Mauve','--project-mauve'],
].map(([label,name]) => ({ label, name }))

const typeScale = [
  { role: 'Micro label', token: '--font-size-micro', size: '10px', weight: 600, sample: 'WORKSPACE · TOKEN' },
  { role: 'Caption', token: '--font-size-xs', size: '11px', weight: 500, sample: '项目阶段 · 刚刚更新' },
  { role: 'Secondary UI', token: '--font-size-sm', size: '12px', weight: 400, sample: '明天下午留给角色设定' },
  { role: 'Body UI', token: '--font-size-body', size: '13px', weight: 400, sample: '咕咕正在整理今天的项目进度。' },
  { role: 'Navigation', token: '--font-size-md', size: '14px', weight: 500, sample: '项目 · 日历 · 文件库' },
  { role: 'Section', token: '--font-size-lg', size: '16px', weight: 600, sample: 'Semantic Tokens' },
  { role: 'Page title', token: '--font-size-title', size: '20px', weight: 700, sample: '项目' },
  { role: 'Display', token: '--font-size-display', size: '24px', weight: 700, sample: 'Design Tokens' },
]
const spacingScale = [
  ['--space-1','4px'],['--space-1-5','6px'],['--space-2','8px'],['--space-2-5','10px'],['--space-3-compact','12px'],['--space-3-5','14px'],['--space-3','16px'],['--space-5','20px'],['--space-4','24px'],['--space-8','32px'],
].map(([token,value]) => ({ token, value }))
const radiusScale = [
  ['--radius-xs','6px'],['--radius-sm','10px'],['--radius-md','14px'],['--radius-lg','18px'],['--radius-xl','20px'],
].map(([token,value]) => ({ token, value }))

const semanticGroups = [
  { title: 'Surface', description: '页面、面板、浮层与安静的局部反馈。', tokens: [
    { label:'Page', name:'--surface-page', usage:'App 背景', demo:'surface' }, { label:'Sidebar', name:'--surface-sidebar', usage:'侧栏', demo:'surface' },
    { label:'Raised', name:'--surface-raised', usage:'控件 / 气泡', demo:'surface' }, { label:'Floating', name:'--surface-floating', usage:'Popup / Window', demo:'surface' },
  ]},
  { title: 'Content', description: '文字层级只由角色决定，不在组件里手调灰度。', tokens: [
    { label:'Primary', name:'--content-primary', usage:'标题 / 正文', demo:'text' }, { label:'Secondary', name:'--content-secondary', usage:'元信息', demo:'text' },
    { label:'Tertiary', name:'--content-tertiary', usage:'提示 / 时间', demo:'text' }, { label:'Disabled', name:'--content-disabled', usage:'不可用', demo:'text' },
  ]},
  { title: 'Border', description: '边框表达层级与交互，不再依赖“越白越玻璃”。', tokens: [
    { label:'Subtle', name:'--border-subtle', usage:'分隔 / 内层边', demo:'border' }, { label:'Default', name:'--border-default', usage:'控件边缘', demo:'border' },
    { label:'Strong', name:'--border-strong', usage:'玻璃卡 / Popup', demo:'border' }, { label:'Focus', name:'--border-focus', usage:'键盘焦点', demo:'border' },
  ]},
  { title: 'Action', description: '紫色是动作，不是环境。', tokens: [
    { label:'Primary', name:'--action-primary', usage:'主按钮', demo:'action' }, { label:'Hover', name:'--action-primary-hover', usage:'主操作 hover', demo:'action' },
    { label:'Pressed', name:'--action-primary-pressed', usage:'按下反馈', demo:'action' }, { label:'Selection', name:'--selection-bg', usage:'选中项背景', demo:'surface' },
  ]},
  { title: 'Status', description: '状态色只表达状态，不参与品牌装饰。', tokens: [
    { label:'Success', name:'--status-success', usage:'在线 / 完成', demo:'status' }, { label:'Warning', name:'--status-warning', usage:'临期 / 休息', demo:'status' },
    { label:'Danger', name:'--status-danger', usage:'错误 / 删除', demo:'status' }, { label:'Info', name:'--status-info', usage:'信息提示', demo:'status' },
  ]},
]

const tokenIndex = [
  { title:'Foundations', items:['--font-sans','--font-size-body','--space-2','--space-3','--radius-sm','--radius-md','--motion-default'] },
  { title:'Semantic', items:['--surface-page','--surface-floating','--content-primary','--content-secondary','--border-subtle','--action-primary','--status-success','--elevation-popup'] },
  { title:'Components', items:['--sidebar-bg','--sidebar-item-active','--topbar-bg','--topbar-shadow','--project-card-shadow','--project-card-sheen-hover','--gugu-fab-bg','--gugu-chat-shadow'] },
]

function indexDotStyle(token: string) {
  const colorLike = /surface|content|border|action|status|bg|gradient|active/.test(token)
  return colorLike ? { background: `var(${token})` } : { background: 'var(--action-primary)' }
}
</script>

<style scoped>
.design-page { height: 100vh; overflow-y: auto; background: var(--surface-page); color: var(--content-primary); font-family: var(--font-sans); font-synthesis: none; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
.design-hero { position: sticky; top: 0; z-index: 50; min-height: 104px; display: flex; align-items: center; gap: var(--space-6); padding: 20px clamp(24px,5vw,72px); background: color-mix(in srgb,var(--surface-base) 72%,transparent); border-bottom: 1px solid var(--border-hairline); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); }
.hero-copy { max-width: 700px; }
.eyebrow, .section-kicker { display: block; color: var(--content-tertiary); font-size: var(--font-size-micro); font-weight: var(--font-weight-semibold); letter-spacing: var(--tracking-label); }
.hero-copy h1 { margin-top: 5px; font-size: var(--font-size-display); line-height: var(--line-height-tight); font-weight: var(--font-weight-bold); letter-spacing: -.02em; }
.hero-copy p { margin-top: 6px; color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); }
.design-content { width: min(1440px,100%); margin: 0 auto; padding: 34px clamp(20px,4vw,56px) 80px; }
.design-section { margin-bottom: 64px; }
.section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); margin-bottom: 20px; }
.section-heading h2 { margin-top: 5px; font-size: 19px; font-weight: var(--font-weight-semibold); letter-spacing: -.015em; }
.section-heading p { max-width: 760px; margin-top: 5px; color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); }
.state-badge { flex-shrink: 0; padding: 6px 9px; border-radius: var(--radius-pill); color: var(--selection-fg); background: var(--selection-bg); border: 1px solid var(--border-subtle); font: var(--font-weight-semibold) var(--font-size-micro) var(--font-sans); letter-spacing: .04em; }
.subsection { margin-top: 26px; }
.subheading { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.subheading h3 { font-size: var(--font-size-body); font-weight: var(--font-weight-semibold); }
.subheading p { color: var(--content-tertiary); font-size: var(--font-size-xs); }
.token-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--design-grid-gap); }
.token-card { min-width: 0; background: var(--design-card-bg); border: 1px solid var(--design-card-border); border-radius: var(--design-card-radius); box-shadow: var(--elevation-card); }
.color-card { overflow: hidden; }
.color-swatch { height: 82px; border-bottom: 1px solid var(--border-hairline); }
.token-meta { padding: 11px 12px 12px; display: flex; flex-direction: column; gap: 3px; }
.token-meta strong { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.token-meta code, .case-meta code, .contract-card code, .index-card code, .type-meta code, .space-row code, .radius-item code { color: var(--selection-fg); font: var(--font-size-micro)/1.4 var(--font-mono); overflow-wrap: anywhere; }
.token-meta span, .case-meta span { color: var(--content-tertiary); font-size: var(--font-size-micro); line-height: var(--line-height-ui); }
.compact-colors .color-swatch { height: 58px; }
.foundation-split { display: grid; grid-template-columns: minmax(0,1.15fr) minmax(0,.85fr); gap: var(--design-grid-gap); margin-top: 26px; }
.foundation-panel { margin-top: 0; padding: 18px; background: var(--design-card-bg); border: 1px solid var(--design-card-border); border-radius: var(--design-card-radius); box-shadow: var(--elevation-card); }
.type-list { display: flex; flex-direction: column; }
.type-row { min-height: 66px; display: grid; grid-template-columns: minmax(0,1fr) 190px; align-items: center; gap: 18px; border-top: 1px solid var(--border-hairline); }
.type-row:first-child { border-top: 0; }
.type-sample { min-width: 0; line-height: var(--line-height-ui); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.type-meta { display: grid; grid-template-columns: 1fr; gap: 2px; }
.type-meta strong { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.type-meta small { color: var(--content-tertiary); font-size: var(--font-size-micro); }
.space-list { display: flex; flex-direction: column; gap: 9px; }
.space-row { display: grid; grid-template-columns: 130px 1fr 34px; align-items: center; gap: 10px; min-height: 20px; }
.space-bar { display: block; min-width: 2px; height: 7px; border-radius: var(--radius-pill); background: var(--action-primary); }
.space-row em { color: var(--content-tertiary); font: normal var(--font-size-micro) var(--font-mono); }
.radius-row { display: grid; grid-template-columns: repeat(5,1fr); gap: 8px; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--border-hairline); }
.radius-item { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.radius-item > span { width: 42px; height: 32px; background: var(--selection-bg); border: 1px solid var(--border-default); }
.radius-item small { color: var(--content-tertiary); font-size: var(--font-size-micro); }
.semantic-groups { display: flex; flex-direction: column; gap: 14px; }
.semantic-group { padding: 16px; background: color-mix(in srgb,var(--surface-card-solid) 56%,transparent); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); }
.semantic-group > header { display: flex; justify-content: space-between; gap: 18px; margin-bottom: 12px; }
.semantic-group > header h3 { font-size: var(--font-size-body); font-weight: var(--font-weight-semibold); }
.semantic-group > header p { margin-top: 3px; color: var(--content-tertiary); font-size: var(--font-size-xs); }
.semantic-group > header > span { color: var(--content-tertiary); font: var(--font-size-micro) var(--font-mono); }
.semantic-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; }
.semantic-card { overflow: hidden; }
.semantic-demo { height: 82px; padding: 12px; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid var(--border-hairline); background: var(--surface-soft); }
.surface-demo { width: 100%; height: 100%; display: grid; place-items: center; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); color: var(--content-secondary); font-size: var(--font-size-micro); }
.text-demo { width: 100%; font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.border-demo { width: 100%; height: 40px; display: flex; align-items: center; padding: 0 10px; border: 1px solid; border-radius: var(--radius-sm); color: var(--content-tertiary); background: var(--surface-raised); font-size: var(--font-size-xs); }
.action-demo { height: 34px; padding: 0 13px; border: 0; border-radius: var(--radius-sm); color: var(--content-on-accent); font: var(--font-weight-medium) var(--font-size-xs) var(--font-sans); box-shadow: var(--elevation-card); }
.status-demo { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: var(--radius-pill); font-size: var(--font-size-xs); font-weight: var(--font-weight-medium); }
.status-demo i { width: 6px; height: 6px; border-radius: 50%; }
.elevation-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--design-grid-gap); }
.elevation-case { min-height: 250px; padding: 18px; display: flex; flex-direction: column; justify-content: center; gap: 20px; background: color-mix(in srgb,var(--surface-soft) 70%,transparent); border: 1px solid var(--border-hairline); border-radius: var(--radius-lg); }
.mini-project { position: relative; overflow: hidden; min-height: 88px; padding: 14px; display: flex; flex-direction: column; gap: 7px; border-radius: var(--project-card-radius); border: 1px solid var(--project-card-border); background: linear-gradient(to right,var(--project-card-gradient-start) 0%,var(--project-card-gradient-end) 40%),var(--project-color); box-shadow: var(--project-card-shadow); }
.mini-project::after { content:''; position:absolute; inset:0; background:var(--project-card-sheen-rest); box-shadow:inset 0 1px 0 var(--project-card-highlight-rest); pointer-events:none; }
.mini-project strong { position: relative; z-index: 1; font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.mini-project span { position: relative; z-index: 1; color: var(--content-secondary); font-size: var(--font-size-xs); }
.hover-case { transform: translateY(-2px); box-shadow: var(--project-card-hover-shadow); }
.hover-case::after { background: var(--project-card-sheen-hover); box-shadow: inset 0 1px 0 var(--project-card-highlight-hover); }
.mini-popup { width: 190px; align-self: center; padding: 12px; display: flex; flex-direction: column; gap: 7px; border-radius: var(--popup-radius); background: var(--popup-background); border: 1px solid var(--popup-border); box-shadow: var(--elevation-popup); }
.mini-popup strong { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.mini-popup span { color: var(--content-secondary); font-size: var(--font-size-xs); }
.mini-popup button { margin-top: 2px; padding: 5px; border: 0; border-radius: var(--radius-xs); color: var(--action-primary); background: var(--action-soft); font: var(--font-size-micro) var(--font-sans); }
.mini-chat { width: 190px; height: 90px; align-self: center; display: flex; align-items: center; gap: 10px; padding: 14px; border-radius: var(--gugu-chat-radius); background: var(--gugu-chat-bg); border: 1px solid var(--gugu-chat-border); box-shadow: var(--gugu-chat-shadow); }
.mini-chat-avatar { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; color: white; background: var(--gugu-fab-bg); }
.mini-chat div { display: flex; flex-direction: column; gap: 2px; }
.mini-chat strong { font-size: var(--font-size-xs); }
.mini-chat small { color: var(--content-tertiary); font-size: var(--font-size-micro); }
.case-meta { display: flex; flex-direction: column; gap: 3px; }
.case-meta strong { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.component-strip { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--design-grid-gap); }
.contract-card { min-height: 94px; display: flex; align-items: center; gap: 12px; padding: 15px; background: var(--design-card-bg); border: 1px solid var(--design-card-border); border-radius: var(--design-card-radius); box-shadow: var(--elevation-card); }
.contract-icon { width: 38px; height: 38px; display: grid; place-items: center; flex-shrink: 0; border-radius: var(--radius-sm); color: var(--action-primary); background: var(--action-soft); }
.gugu-icon { color: white; background: var(--gugu-fab-bg); }
.contract-card div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.contract-card strong { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.contract-card small { color: var(--content-tertiary); font-size: var(--font-size-micro); }
.index-groups { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: var(--design-grid-gap); }
.index-group { padding: 14px; border-radius: var(--radius-lg); background: color-mix(in srgb,var(--surface-card-solid) 50%,transparent); border: 1px solid var(--border-subtle); }
.index-group header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.index-group h3 { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.index-group header span { color: var(--content-tertiary); font: var(--font-size-micro) var(--font-mono); }
.index-grid { display: flex; flex-direction: column; gap: 6px; }
.index-card { min-height: 38px; padding: 9px 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; box-shadow: none; }
.index-dot { width: 18px; height: 18px; flex-shrink: 0; border-radius: 6px; border: 1px solid var(--border-subtle); }
/* Product sample */
.product-frame { position: relative; height: 620px; overflow: hidden; display: flex; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-page); box-shadow: var(--elevation-popup); }
.sample-sidebar { width: var(--sidebar-width); height: 100%; flex-shrink: 0; display: flex; flex-direction: column; padding: 24px 14px; background: var(--sidebar-bg); border-right: 1px solid var(--sidebar-border); box-shadow: inset -1px 0 0 var(--sidebar-highlight); backdrop-filter: var(--popup-blur); -webkit-backdrop-filter: var(--popup-blur); }
.sample-logo { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 0 8px; margin-bottom: 20px; }
.sample-logo-icon { width: 34px; height: 34px; display: grid; place-items: center; border-radius: var(--radius-sm); color: white; background: var(--brand-gradient); box-shadow: inset 0 1px 0 color-mix(in srgb,white 40%,transparent); }
.sample-logo strong { font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); }
.sample-nav { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.sample-divider { height: 1px; margin: 6px 4px; background: var(--divider-line); }
.sample-nav-label { padding: 0 10px; margin-bottom: 4px; color: var(--sidebar-label-fg); font-size: var(--font-size-micro); font-weight: var(--font-weight-semibold); letter-spacing: .08em; text-transform: uppercase; }
.sample-nav-item { width: 100%; display: flex; align-items: center; gap: 9px; padding: 10px 12px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--sidebar-item-fg); background: transparent; font: var(--font-weight-regular) var(--font-size-md) var(--font-sans); text-align: left; }
.sample-nav-item.active { color: var(--sidebar-item-active-fg); background: var(--sidebar-item-active); border-color: var(--sidebar-item-active-border); box-shadow: var(--sidebar-item-active-shadow); font-weight: var(--font-weight-semibold); }
.sample-nav-item.muted { color: var(--content-tertiary); }
.nav-count { margin-left: auto; padding: 1px 6px; border-radius: var(--radius-pill); color: white; background: color-mix(in srgb,var(--action-primary) 42%,transparent); font-size: var(--font-size-micro); }
.soon { margin-left: auto; color: var(--content-tertiary); font-size: 9px; }
.sample-user { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: var(--radius-md); background: var(--sidebar-user-bg); border: 1px solid var(--sidebar-user-border); box-shadow: var(--sidebar-item-active-shadow); }
.sample-avatar { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; color: white; background: linear-gradient(135deg,var(--action-primary),var(--status-info)); font-size: var(--font-size-body); font-weight: var(--font-weight-bold); }
.sample-user div { min-width: 0; display: flex; flex-direction: column; }
.sample-user strong { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.sample-user small { color: var(--content-tertiary); font-size: var(--font-size-micro); }
.sample-main { position: relative; flex: 1; min-width: 0; overflow: hidden; }
.sample-topbar { position: absolute; top: 20px; left: 20px; right: 24px; z-index: 5; min-height: 68px; display: flex; align-items: center; gap: 14px; padding: 14px 20px; border: 1px solid var(--topbar-border); border-radius: var(--radius-lg); background: var(--topbar-bg); box-shadow: var(--topbar-shadow); backdrop-filter: blur(var(--topbar-blur)); -webkit-backdrop-filter: blur(var(--topbar-blur)); }
.sample-title { flex-shrink: 0; }
.sample-title h3 { font-size: var(--topbar-title-size); line-height: 1.2; font-weight: var(--font-weight-bold); }
.sample-title span { display: block; margin-top: 2px; color: var(--content-secondary); font-size: var(--topbar-meta-size); }
.sample-search { min-width: 180px; max-width: 310px; height: var(--control-md); margin-left: auto; display: flex; align-items: center; gap: 8px; padding: 0 10px; border-radius: var(--control-radius); color: var(--content-secondary); background: var(--control-bg); border: 1px solid var(--control-border); font-size: var(--font-size-xs); }
.sample-search span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.sample-search kbd { margin-left: auto; padding: 1px 4px; border: 1px solid var(--border-subtle); border-radius: 4px; color: var(--content-tertiary); background: var(--surface-soft); font: var(--font-size-micro) var(--font-sans); }
.sample-ghost, .sample-primary { height: var(--control-md); display: inline-flex; align-items: center; gap: 5px; padding: 0 11px; border-radius: var(--control-radius); font: var(--font-weight-medium) var(--font-size-xs) var(--font-sans); white-space: nowrap; }
.sample-ghost { color: var(--content-secondary); background: var(--control-bg); border: 1px solid var(--control-border); box-shadow: inset 0 1px 0 var(--border-highlight); }
.sample-primary { color: var(--content-on-accent); background: var(--action-primary); border: 1px solid transparent; box-shadow: 0 3px 12px color-mix(in srgb,var(--action-primary) 30%,transparent); }
.sample-board { height: 100%; padding: 116px 30px 24px; display: grid; grid-template-columns: repeat(3,minmax(190px,1fr)); gap: 14px; overflow: hidden; }
.project-column { min-width: 0; padding: 10px; display: flex; flex-direction: column; gap: 8px; border-radius: var(--radius-md); background: var(--surface-column); }
.column-heading { display: flex; align-items: center; gap: 7px; padding: 3px 3px 5px; }
.column-heading strong { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.column-heading em { margin-left: auto; color: var(--content-tertiary); font: normal var(--font-size-micro) var(--font-mono); }
.column-dot { width: 7px; height: 7px; border-radius: 50%; }
.sample-project-card { position: relative; overflow: hidden; min-height: 104px; border: 1px solid var(--project-card-border); border-radius: var(--project-card-radius); background: linear-gradient(to right,var(--project-card-gradient-start) 0%,var(--project-card-gradient-end) 40%),var(--project-color); box-shadow: var(--project-card-shadow); }
.sample-project-card::before { content:''; position:absolute; inset:0; background:var(--project-card-sheen-rest); box-shadow:inset 0 1px 0 var(--project-card-highlight-rest); pointer-events:none; }
.sample-project-card:hover { transform: translateY(-2px); border-color: var(--project-card-hover-border); box-shadow: var(--project-card-hover-shadow); }
.sample-project-card:hover::before { background: var(--project-card-sheen-hover); box-shadow: inset 0 1px 0 var(--project-card-highlight-hover); }
.card-copy { position: relative; z-index: 1; padding: 11px 12px 10px; display: flex; flex-direction: column; gap: 8px; }
.card-name-row, .card-meta, .card-footer { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.card-name-row strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.stars { color: var(--action-primary); font-size: 8px; letter-spacing: -1px; }
.card-meta { color: var(--content-secondary); font-size: var(--font-size-micro); }
.card-footer { color: var(--content-secondary); font-size: var(--font-size-micro); }
.card-footer > span { display: inline-flex; align-items: center; gap: 4px; }
.card-footer b { color: var(--content-tertiary); font: var(--font-weight-semibold) var(--font-size-micro) var(--font-sans); }
.progress-track { height: 3px; overflow: hidden; border-radius: var(--radius-pill); background: var(--surface-soft-hover); }
.progress-track i { display: block; height: 100%; border-radius: inherit; background: var(--project-color); }
.add-project { height: 30px; display: flex; align-items: center; justify-content: center; gap: 4px; border: 1px dashed var(--border-subtle); border-radius: var(--radius-sm); color: var(--content-tertiary); background: transparent; font: var(--font-size-micro) var(--font-sans); }
.sample-gugu-fab { position: absolute; right: var(--floating-edge); bottom: var(--floating-edge); z-index: 16; width: var(--gugu-fab-size); height: var(--gugu-fab-size); display: grid; place-items: center; border: 1px solid var(--gugu-fab-border); border-radius: 50%; color: white; background: var(--gugu-fab-bg); box-shadow: var(--gugu-fab-shadow); cursor: pointer; transition: transform .2s,box-shadow .2s,opacity .2s; }
.sample-gugu-fab:hover { transform: scale(1.08); box-shadow: var(--gugu-fab-hover-shadow); }
.sample-gugu-fab.opened { opacity: 0; pointer-events: none; transform: scale(.9); }
@media (max-width: 1100px) { .token-grid,.semantic-grid,.elevation-grid,.component-strip { grid-template-columns: repeat(2,minmax(0,1fr)); } .index-groups { grid-template-columns: 1fr; } .sample-sidebar { width: 188px; } .sample-board { padding-left: 18px; padding-right: 18px; } .sample-search { display: none; } }
@media (max-width: 760px) { .design-hero { position: relative; flex-direction: column; align-items: flex-start; } .design-content { padding-top: 24px; } .foundation-split { grid-template-columns: 1fr; } .token-grid,.semantic-grid,.elevation-grid,.component-strip { grid-template-columns: 1fr; } .sample-sidebar { display: none; } .sample-board { grid-template-columns: repeat(3,240px); overflow-x: auto; } .sample-topbar { right: 12px; left: 12px; padding: 12px; } .sample-ghost { display:none; } .type-row { grid-template-columns: 1fr; padding: 10px 0; gap: 5px; } .radius-row { grid-template-columns: repeat(3,1fr); } }
</style>
