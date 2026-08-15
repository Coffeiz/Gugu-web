<template>
  <div class="design-page">
    <header class="design-hero">
      <div class="hero-copy">
        <div class="hero-title-row"><span class="eyebrow">GUGU · DESIGN</span><h1>Design Tokens</h1></div>
        <p>Glass / V2 × Light / Dark · 产品样板只消费真实 Semantic / Component tokens。</p>
      </div>
      <ThemeSwitcher :model-value="preference" :family="family" @update:model-value="setTheme" @update:family="setFamily" />
    </header>

    <main class="design-content">
      <!-- token.html 的四格主题切换：保留预览、hover 和 active outline 的交互。 -->
      <div class="theme-matrix" aria-label="主题组合">
        <button
          v-for="choice in themeChoices"
          :key="choice.family + choice.mode"
          class="theme-cell"
          :class="[choice.family + '-' + choice.mode, { active: family === choice.family && resolved === choice.mode }]"
          @click="applyTheme(choice)"
        >
          <div class="theme-mini">
            <span class="mini-side"><i/><i/><i/></span>
            <span class="mini-canvas"><i/><i/><i/></span>
          </div>
          <span><strong>{{ choice.label }}</strong><small>{{ choice.note }}</small></span>
        </button>
      </div>

      <!-- Product sample: deliberately NOT wrapped by another glass section. -->
      <section class="design-section product-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">01 · PRODUCT SAMPLE</span>
            <h2>真实项目页样板</h2>
            <p>Preview frame / Column 回到 token.html；项目卡使用真实 ProjectCard 的横向项目色、sheen、hover / active 动画。</p>
          </div>
          <span class="state-badge">{{ family.toUpperCase() }} · {{ resolved.toUpperCase() }}</span>
        </div>

        <div class="product-frame">
          <aside class="sample-sidebar">
            <div class="sample-logo"><span class="sample-logo-icon"><BirdIcon :size="18" /></span><strong>咕咕</strong></div>
            <nav class="sample-nav">
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
            <div class="sample-user"><span class="sample-avatar">C</span><div><strong>Coffeiz</strong><small>创作者</small></div></div>
          </aside>

          <div class="sample-main">
            <!-- 顶部静止时无底色；真实项目滚动后由 product.css 的 scroll timeline 淡入 GlassBg。 -->
            <header class="sample-topbar">
              <div class="sample-title"><h3>项目</h3><span>8月15日 · 星期六</span></div>
              <div class="sample-search"><PhMagnifyingGlass :size="14" /><span>搜索项目、文件、日程、客户…</span><kbd>⌘ K</kbd></div>
              <div class="sample-top-actions">
                <button class="sample-ghost"><PhUploadSimple :size="13" weight="bold" />上传</button>
                <button class="sample-primary"><PhPlus :size="13" weight="bold" />新建项目</button>
              </div>
            </header>

            <div class="sample-board">
              <div v-for="column in projectColumns" :key="column.title" class="project-column">
                <header class="column-heading"><span class="column-dot" :style="{ background: column.dot }" /><strong>{{ column.title }}</strong><em>{{ column.cards.length }}</em></header>
                <article v-for="card in column.cards" :key="card.name" class="sample-project-card" :style="{ '--project-color': card.color }">
                  <div class="card-copy">
                    <div class="card-name-row"><strong>{{ card.name }}</strong><span class="stars">{{ card.stars }}</span></div>
                    <div class="card-meta"><span>{{ card.client }}</span><span class="stage-chip">{{ card.stage }}</span></div>
                    <div class="card-footer"><span><PhCalendarBlank :size="11" />{{ card.date }}</span><span>{{ card.done }}/{{ card.total }}</span></div>
                    <div class="seg-progress" aria-hidden="true"><i v-for="n in card.total" :key="n" :class="{ done: n <= card.done }" /></div>
                  </div>
                </article>
                <button class="add-project"><PhPlus :size="12" /> 添加项目</button>
              </div>
            </div>
          </div>

          <button class="sample-gugu-fab" title="切换 GuguChat" @click="chatOpen = !chatOpen"><BirdIcon :size="22" /></button>
          <GuguChatMock :open="chatOpen" @close="chatOpen = false" />
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading"><div><span class="section-kicker">02 · FOUNDATIONS</span><h2>颜色、字体与空间</h2><p>公开 API 保持简单；内部 palette 只服务主题实现。字号 / 间距 / 圆角均不超过五档。</p></div></div>
        <div class="subsection first-subsection">
          <div class="subheading"><h3>System color</h3><p>主题切换只重新映射语义，不改组件代码。</p></div>
          <div class="token-grid color-grid">
            <article v-for="token in systemColors" :key="token.name" class="token-card color-card"><div class="color-swatch" :style="{ background: `var(${token.name})` }" /><div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.note }}</span></div></article>
          </div>
        </div>
        <div class="subsection">
          <div class="subheading"><h3>Project color</h3><p>内容色跨 Glass / V2 保持身份。</p></div>
          <div class="token-grid color-grid compact-colors">
            <article v-for="token in projectColors" :key="token.name" class="token-card color-card"><div class="color-swatch" :style="{ background: `var(${token.name})` }" /><div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code></div></article>
          </div>
        </div>
        <div class="foundation-split">
          <div class="foundation-panel">
            <div class="subheading"><h3>Typography · 5</h3><p>11 / 12 / 14 / 16 / 20</p></div>
            <div class="type-list"><div v-for="row in typeScale" :key="row.token" class="type-row"><span class="type-sample" :style="{ fontSize: `var(${row.token})`, fontWeight: row.weight }">{{ row.sample }}</span><div class="type-meta"><strong>{{ row.role }}</strong><code>{{ row.token }}</code><small>{{ row.size }}</small></div></div></div>
          </div>
          <div class="foundation-panel">
            <div class="subheading"><h3>Spacing · 5</h3><p>4 / 8 / 12 / 16 / 24</p></div>
            <div class="space-list"><div v-for="item in spacingScale" :key="item.token" class="space-row"><code>{{ item.token }}</code><span class="space-bar" :style="{ width: `var(${item.token})` }" /><em>{{ item.value }}</em></div></div>
            <div class="radius-title"><h3>Radius · 5</h3><p>四档几何圆角 + pill</p></div>
            <div class="radius-row"><div v-for="item in radiusScale" :key="item.token" class="radius-item"><span :style="{ borderRadius: `var(${item.token})` }" /><code>{{ item.token }}</code><small>{{ item.value }}</small></div></div>
          </div>
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading"><div><span class="section-kicker">03 · SEMANTIC TOKENS</span><h2>角色 + 实际使用模板</h2><p>每张卡直接演示它在 Surface / Text / Border / Action / Status 中的真实用法。</p></div></div>
        <div class="semantic-groups">
          <article v-for="group in semanticGroups" :key="group.title" class="semantic-group">
            <header><div><h3>{{ group.title }}</h3><p>{{ group.description }}</p></div><span>{{ group.tokens.length }}</span></header>
            <div class="semantic-grid">
              <div v-for="token in group.tokens" :key="token.name" class="token-card semantic-card">
                <div class="semantic-demo">
                  <div v-if="token.demo === 'surface'" class="surface-demo" :style="{ background: `var(${token.name})` }">Surface</div>
                  <div v-else-if="token.demo === 'text'" class="text-demo" :style="{ color: `var(${token.name})` }">咕咕正在整理项目</div>
                  <div v-else-if="token.demo === 'border'" class="border-demo" :style="{ borderColor: `var(${token.name})` }">Input / Card edge</div>
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
        <div class="section-heading"><div><span class="section-kicker">04 · ELEVATION</span><h2>真实产品层级</h2><p>Card rest / hover、Popup、GuguChat Window，而不是无语义阴影样片。</p></div></div>
        <div class="elevation-grid">
          <article class="elevation-case"><div class="mini-project" style="--project-color:var(--project-lilac)"><strong>项目卡 · Rest</strong><span>角色设定 · 2/4</span></div><div class="case-meta"><strong>Card rest</strong><code>--elevation-card</code><span>项目 / 文件卡</span></div></article>
          <article class="elevation-case"><div class="mini-project hover-case" style="--project-color:var(--project-sky)"><strong>项目卡 · Hover</strong><span>画册排版 · 3/4</span></div><div class="case-meta"><strong>Card hover</strong><code>--elevation-card-hover</code><span>真实 -2px 抬起</span></div></article>
          <article class="elevation-case"><div class="mini-popup"><strong>当前阶段</strong><span>✓ 草图确认</span><span>○ 线稿整理</span><button>＋ 添加待办</button></div><div class="case-meta"><strong>Popup</strong><code>--elevation-popup</code><span>菜单 / 搜索</span></div></article>
          <article class="elevation-case"><div class="mini-chat"><span><BirdIcon :size="15" /></span><div><strong>GuguChat</strong><small>Window level</small></div></div><div class="case-meta"><strong>Window</strong><code>--elevation-window</code><span>聊天 / 浮窗</span></div></article>
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading"><div><span class="section-kicker">05 · COMPONENT CONTRACTS</span><h2>产品对象</h2><p>业务组件只引用 Component contract。</p></div></div>
        <div class="component-strip">
          <div v-for="item in contracts" :key="item.name" class="contract-card"><span class="contract-icon" :class="{ gugu: item.name === 'Gugu' }"><component :is="item.icon" :size="18" /></span><div><strong>{{ item.name }}</strong><code>{{ item.token }}</code><small>{{ item.note }}</small></div></div>
        </div>
      </section>

      <section class="design-section index-section">
        <div class="section-heading"><div><span class="section-kicker">06 · TOKEN INDEX</span><h2>统一索引卡</h2><p>与颜色卡、Semantic 卡使用同一套表面和文字规则。</p></div></div>
        <div class="index-groups"><article v-for="group in tokenIndex" :key="group.title" class="index-group"><header><h3>{{ group.title }}</h3><span>{{ group.items.length }}</span></header><div class="index-grid"><div v-for="item in group.items" :key="item" class="token-card index-card"><code>{{ item }}</code><span class="index-dot" :style="indexDotStyle(item)" /></div></div></article></div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { h, ref } from 'vue'
import { PhAddressBook, PhAlarm, PhBrowser, PhCalendarBlank, PhFolder, PhGraph, PhMagnifyingGlass, PhPlus, PhSidebarSimple, PhStack, PhUploadSimple } from '@phosphor-icons/vue'
import { useTheme } from '@/composables/useTheme'
import ThemeSwitcher from './ThemeSwitcher.vue'
import GuguChatMock from './GuguChatMock.vue'

const { preference, resolved, family, setTheme, setFamily } = useTheme()
const chatOpen = ref(false)
const themeChoices = [
  { family:'glass', mode:'light', label:'Glass Light', note:'原始咕咕玻璃' },
  { family:'glass', mode:'dark', label:'Glass Dark', note:'低亮度透明层' },
  { family:'v2', mode:'light', label:'V2 Light', note:'Pearl / Ink / Iris' },
  { family:'v2', mode:'dark', label:'V2 Dark', note:'低拟态实体表面' },
] as const
function applyTheme(choice: typeof themeChoices[number]) { setFamily(choice.family); setTheme(choice.mode) }

const BirdIcon = (props: { size?: number }) => h('svg', { width:props.size ?? 18,height:props.size ?? 18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round' }, [
  h('path',{d:'M16 7h.01'}),h('path',{d:'M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20'}),h('path',{d:'M20 7l2 .5-2 .5'}),h('path',{d:'M10 18v3'}),h('path',{d:'M14 17.75V21'}),
])

const projectColumns = [
  { title:'待开始', dot:'var(--project-sand)', cards:[
    { name:'夏日插画',client:'个人创作',stage:'构思',date:'8/18 → 8/25',done:1,total:4,stars:'★★☆',color:'var(--project-sand)' },
    { name:'网站作品集',client:'Coffeiz',stage:'素材',date:'8/20 → 9/02',done:1,total:5,stars:'★☆☆',color:'var(--project-mauve)' },
  ]},
  { title:'进行中', dot:'var(--action-primary)', cards:[
    { name:'角色设定',client:'原创项目',stage:'线稿',date:'8/12 → 8/19',done:2,total:4,stars:'★★★',color:'var(--project-lilac)' },
    { name:'画册排版',client:'人生对比色',stage:'版式',date:'8/10 → 8/22',done:3,total:4,stars:'★★☆',color:'var(--project-sky)' },
  ]},
  { title:'待确认', dot:'var(--project-rose)', cards:[
    { name:'封面设计',client:'委托',stage:'配色确认',date:'8/14 → 8/20',done:3,total:5,stars:'★★☆',color:'var(--project-rose)' },
  ]},
  { title:'已完成', dot:'var(--status-success)', cards:[
    { name:'七月头像稿',client:'委托',stage:'完成',date:'8/06',done:4,total:4,stars:'★★☆',color:'var(--project-leaf)' },
  ]},
]

const systemColors = [
  ['Primary','--color-primary','主操作 / 品牌动作'],['Text','--color-text','主要内容'],['Muted','--color-muted','次级内容'],['Surface','--color-surface','实体表面'],['Line','--color-line','控件 / 分隔'],['Success','--color-success','完成 / 在线'],['Warning','--color-warning','临期 / 休息'],['Danger','--color-danger','错误 / 删除'],['Info','--color-info','信息提示'],
].map(([label,name,note])=>({label,name,note}))
const projectColors = [['Lilac','--project-lilac'],['Rose','--project-rose'],['Sky','--project-sky'],['Leaf','--project-leaf'],['Sand','--project-sand'],['Coral','--project-coral'],['Blue','--project-blue'],['Mauve','--project-mauve']].map(([label,name])=>({label,name}))
const typeScale = [
  {role:'Caption',token:'--font-size-xs',size:'11px',weight:500,sample:'项目阶段 · 刚刚更新'},
  {role:'Secondary',token:'--font-size-sm',size:'12px',weight:400,sample:'明天下午留给角色设定'},
  {role:'Body / Nav',token:'--font-size-md',size:'14px',weight:500,sample:'咕咕正在整理今天的项目进度。'},
  {role:'Section',token:'--font-size-lg',size:'16px',weight:600,sample:'Semantic Tokens'},
  {role:'Title',token:'--font-size-xl',size:'20px',weight:700,sample:'Design Tokens'},
]
const spacingScale = [['--space-xs','4px'],['--space-sm','8px'],['--space-md','12px'],['--space-lg','16px'],['--space-xl','24px']].map(([token,value])=>({token,value}))
const radiusScale = [['--radius-xs','6px'],['--radius-sm','10px'],['--radius-md','14px'],['--radius-lg','20px'],['--radius-pill','pill']].map(([token,value])=>({token,value}))
const semanticGroups = [
  {title:'Surface',description:'页面、面板、浮层。',tokens:[{label:'Page',name:'--surface-page',usage:'App 背景',demo:'surface'},{label:'Sidebar',name:'--surface-sidebar',usage:'侧栏',demo:'surface'},{label:'Raised',name:'--surface-raised',usage:'控件 / 气泡',demo:'surface'},{label:'Floating',name:'--surface-floating',usage:'Popup / Window',demo:'surface'}]},
  {title:'Content',description:'文字只按角色分层。',tokens:[{label:'Primary',name:'--content-primary',usage:'标题 / 正文',demo:'text'},{label:'Secondary',name:'--content-secondary',usage:'元信息',demo:'text'},{label:'Tertiary',name:'--content-tertiary',usage:'提示 / 时间',demo:'text'},{label:'Disabled',name:'--content-disabled',usage:'不可用',demo:'text'}]},
  {title:'Border',description:'边框表达层级与焦点。',tokens:[{label:'Subtle',name:'--border-subtle',usage:'分隔 / 内层边',demo:'border'},{label:'Default',name:'--border-default',usage:'控件边缘',demo:'border'},{label:'Strong',name:'--border-strong',usage:'Glass / Popup',demo:'border'},{label:'Focus',name:'--border-focus',usage:'键盘焦点',demo:'border'}]},
  {title:'Action',description:'Iris 只承担动作。',tokens:[{label:'Primary',name:'--action-primary',usage:'主按钮',demo:'action'},{label:'Hover',name:'--action-primary-hover',usage:'主操作 hover',demo:'action'},{label:'Pressed',name:'--action-primary-pressed',usage:'按下反馈',demo:'action'},{label:'Selection',name:'--selection-bg',usage:'选中背景',demo:'surface'}]},
  {title:'Status',description:'状态色不参与环境装饰。',tokens:[{label:'Success',name:'--status-success',usage:'在线 / 完成',demo:'status'},{label:'Warning',name:'--status-warning',usage:'临期 / 休息',demo:'status'},{label:'Danger',name:'--status-danger',usage:'错误 / 删除',demo:'status'},{label:'Info',name:'--status-info',usage:'信息提示',demo:'status'}]},
]
const contracts = [
  {name:'Sidebar',token:'--sidebar-*',note:'导航 / 用户卡',icon:PhSidebarSimple},{name:'Topbar',token:'--topbar-*',note:'滚动后出现玻璃',icon:PhBrowser},{name:'Project Card',token:'--project-card-*',note:'真实项目色与动画',icon:PhStack},{name:'Gugu',token:'--gugu-*',note:'FAB / Chat',icon:BirdIcon},
]
const tokenIndex = [
  {title:'Foundations',items:['--font-size-xs','--font-size-sm','--font-size-md','--font-size-lg','--font-size-xl','--space-xs','--space-sm','--space-md','--space-lg','--space-xl','--radius-xs','--radius-sm','--radius-md','--radius-lg','--radius-pill']},
  {title:'Semantic',items:['--color-primary','--color-text','--color-muted','--color-surface','--surface-floating','--content-primary','--border-subtle','--status-success','--elevation-popup']},
  {title:'Components',items:['--sidebar-item-active','--topbar-bg','--project-card-shadow','--project-card-motion','--gugu-chat-bg','--gugu-chat-sidebar-bg','--gugu-fab-bg']},
]
function indexDotStyle(token:string){return /color|surface|content|border|action|status|bg|active/.test(token)?{background:`var(${token})`}:{background:'var(--action-primary)'}}
</script>

<style scoped>
.design-page{height:100vh;overflow-y:auto;background:var(--surface-page);color:var(--content-primary);font-family:var(--font-sans);font-synthesis:none;-webkit-font-smoothing:antialiased}
.design-hero{position:sticky;top:0;z-index:50;min-height:58px;display:flex;align-items:center;gap:var(--space-xl);padding:var(--space-sm) clamp(var(--space-lg),3vw,56px);background:color-mix(in srgb,var(--surface-glass) 78%,transparent);border-bottom:1px solid var(--border-strong);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.hero-copy{min-width:0;max-width:760px}.hero-title-row{display:flex;align-items:baseline;gap:var(--space-sm)}.eyebrow,.section-kicker{color:var(--content-tertiary);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);letter-spacing:var(--tracking-label)}.hero-copy h1{font-size:var(--font-size-xl);line-height:var(--line-height-tight)}.hero-copy p{margin-top:var(--space-xs);color:var(--content-secondary);font-size:var(--font-size-xs);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.design-content{width:min(1440px,100%);margin:0 auto;padding:var(--space-xl) clamp(var(--space-lg),4vw,56px) 72px}

/* token.html theme matrix */
.theme-matrix{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-sm);margin-bottom:var(--space-xl)}
.theme-cell{min-width:0;padding:var(--space-sm);display:flex;align-items:center;gap:var(--space-sm);border:1px solid var(--border-subtle);border-radius:var(--radius-md);color:var(--content-secondary);background:var(--surface-base);box-shadow:var(--elevation-card);font-family:var(--font-sans);text-align:left;cursor:pointer;transition:transform .18s var(--ease-standard),box-shadow .18s var(--ease-standard),outline-color .18s ease}
.theme-cell:hover{transform:translateY(-1px);box-shadow:var(--elevation-card-hover)}.theme-cell.active{outline:2px solid var(--focus-ring);outline-offset:1px}.theme-cell>span:last-child{min-width:0;display:flex;flex-direction:column}.theme-cell strong{font-size:var(--font-size-sm);color:var(--content-primary)}.theme-cell small{margin-top:var(--space-xs);font-size:var(--font-size-xs);color:var(--content-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.theme-mini{width:72px;height:42px;flex-shrink:0;display:grid;grid-template-columns:20px 1fr;overflow:hidden;border:1px solid rgba(100,100,120,.12);border-radius:var(--radius-sm);background:var(--preview-bg)}.mini-side{padding:5px 3px;display:flex;flex-direction:column;gap:3px;background:var(--preview-side)}.mini-side i{height:3px;border-radius:var(--radius-pill);background:var(--preview-line)}.mini-canvas{padding:6px;display:flex;flex-direction:column;gap:4px}.mini-canvas i{height:7px;border:1px solid var(--preview-border);border-radius:4px;background:var(--preview-card)}
.glass-light{--preview-bg:linear-gradient(145deg,#e8e9ee,#a7afc2);--preview-side:rgba(255,255,255,.48);--preview-card:rgba(255,255,255,.72);--preview-line:#7b7fb2;--preview-border:rgba(255,255,255,.75)}
.glass-dark{--preview-bg:linear-gradient(145deg,#0e101a,#17192b);--preview-side:rgba(28,30,47,.88);--preview-card:rgba(255,255,255,.07);--preview-line:#9590c4;--preview-border:rgba(255,255,255,.10)}
.v2-light{--preview-bg:linear-gradient(180deg,#f5f3f6,#eeecf0);--preview-side:#f8f6f9;--preview-card:#fbfafc;--preview-line:#7067a5;--preview-border:rgba(42,35,49,.09)}
.v2-dark{--preview-bg:linear-gradient(180deg,#1c1921,#17151b);--preview-side:#201d25;--preview-card:#24212a;--preview-line:#a49acb;--preview-border:rgba(255,255,255,.08)}

.design-section{position:relative;margin-bottom:var(--design-section-gap);padding:var(--space-xl);background:var(--design-section-bg);border:1px solid var(--design-section-border);border-radius:var(--design-section-radius);box-shadow:var(--design-section-shadow),inset 0 1px 0 var(--design-section-highlight);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
/* Product preview itself is the shell, exactly like token.html: no glass around glass. */
.product-section{padding:0;background:transparent;border:0;border-radius:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
:global(html[data-family='v2']) .design-section:not(.product-section){background:var(--surface-base);border-color:var(--border-subtle);box-shadow:var(--elevation-card);backdrop-filter:none;-webkit-backdrop-filter:none}
.section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-xl);margin-bottom:var(--space-lg)}.section-heading h2{margin-top:var(--space-xs);font-size:var(--font-size-lg);font-weight:var(--font-weight-semibold)}.section-heading p{max-width:820px;margin-top:var(--space-xs);color:var(--content-secondary);font-size:var(--font-size-sm);line-height:var(--line-height-body)}.state-badge{padding:var(--space-xs) var(--space-sm);border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--selection-fg);background:var(--selection-bg);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold)}

/* Product sample = token.html preview-frame */
.product-frame{position:relative;height:650px;display:grid;grid-template-columns:var(--sidebar-width) 1fr;overflow:hidden;border:1px solid var(--border-default);border-radius:var(--radius-lg);background:var(--app-background);box-shadow:var(--elevation-popup)}
.sample-sidebar{height:100%;display:flex;flex-direction:column;padding:var(--space-xl) var(--space-md) var(--space-md);background:var(--sidebar-bg);border-right:1px solid var(--border-subtle);box-shadow:inset -1px 0 0 var(--sidebar-highlight);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
:global(html[data-family='v2']) .sample-sidebar{box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
.sample-logo{display:flex;align-items:center;justify-content:center;gap:var(--space-sm);margin-bottom:var(--space-xl)}.sample-logo-icon{width:34px;height:34px;display:grid;place-items:center;border-radius:var(--radius-sm);color:#fff;background:var(--brand-gradient)}.sample-logo strong{font-size:var(--font-size-lg)}.sample-nav{flex:1;display:flex;flex-direction:column;gap:var(--space-xs)}.sample-nav-label{padding:var(--space-xs) var(--space-sm);color:var(--sidebar-label-fg);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);letter-spacing:var(--tracking-label)}.sample-divider{height:1px;margin:var(--space-sm) var(--space-xs);background:var(--divider-line)}
.sample-nav-item{width:100%;display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border:1px solid transparent;border-radius:var(--radius-sm);color:var(--sidebar-item-fg);background:transparent;font:var(--font-weight-regular) var(--font-size-md) var(--font-sans);text-align:left}.sample-nav-item.active{color:var(--sidebar-item-active-fg);background:var(--sidebar-item-active);border-color:var(--sidebar-item-active-border);box-shadow:var(--sidebar-item-active-shadow);font-weight:var(--font-weight-bold)}.nav-count{margin-left:auto;padding:1px var(--space-xs);border-radius:var(--radius-pill);color:#fff;background:color-mix(in srgb,var(--action-primary) 42%,transparent);font-size:var(--font-size-xs)}.sample-nav-item.muted,.soon{color:var(--content-tertiary)}.soon{margin-left:auto;font-size:var(--font-size-xs)}.sample-user{display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm);border:1px solid var(--sidebar-user-border);border-radius:var(--radius-md);background:var(--sidebar-user-bg)}.sample-avatar{width:32px;height:32px;display:grid;place-items:center;border-radius:var(--radius-pill);color:#fff;background:var(--brand-gradient);font-size:var(--font-size-sm);font-weight:var(--font-weight-bold)}.sample-user div{display:flex;flex-direction:column}.sample-user strong{font-size:var(--font-size-sm)}.sample-user small{font-size:var(--font-size-xs);color:var(--content-tertiary)}
.sample-main{position:relative;min-width:0;overflow:hidden}.sample-topbar{position:absolute;top:var(--space-lg);left:var(--space-lg);right:var(--space-lg);z-index:5;height:50px;display:flex;align-items:center;gap:var(--space-md);padding:0 var(--space-md);border:1px solid transparent;border-radius:var(--radius-md);background:transparent;box-shadow:none}.sample-title{display:flex;align-items:baseline;gap:var(--space-sm);white-space:nowrap}.sample-title h3{font-size:var(--font-size-lg)}.sample-title span{font-size:var(--font-size-xs);color:var(--content-tertiary)}.sample-search{height:var(--control-sm);min-width:180px;max-width:320px;flex:1;margin-left:auto;display:flex;align-items:center;gap:var(--space-sm);padding:0 var(--space-sm);border:1px solid var(--control-border);border-radius:var(--control-radius);color:var(--content-secondary);background:color-mix(in srgb,var(--control-bg) 74%,transparent);font-size:var(--font-size-xs)}.sample-search span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sample-search kbd{margin-left:auto;color:var(--content-tertiary);font-size:var(--font-size-xs)}.sample-top-actions{display:flex;gap:var(--space-sm)}.sample-ghost,.sample-primary{height:var(--control-sm);display:flex;align-items:center;gap:var(--space-xs);padding:0 var(--space-sm);border-radius:var(--control-radius);font:var(--font-weight-medium) var(--font-size-xs) var(--font-sans)}.sample-ghost{border:1px solid var(--control-border);color:var(--content-secondary);background:var(--control-bg)}.sample-primary{border:0;color:#fff;background:var(--brand-gradient);box-shadow:var(--elevation-card)}
.sample-board{height:100%;padding:82px var(--space-lg) var(--space-lg);display:grid;grid-template-columns:repeat(4,minmax(145px,1fr));gap:var(--space-sm);overflow:hidden}.project-column{min-width:0;height:100%;padding:var(--space-sm);overflow:hidden;border:1px solid var(--border-hairline);border-radius:var(--radius-md);background:var(--column-bg)}.column-heading{height:26px;display:flex;align-items:center;gap:var(--space-xs);padding:0 var(--space-xs) var(--space-sm)}.column-heading strong{font-size:var(--font-size-sm);font-weight:var(--font-weight-semibold)}.column-heading em{margin-left:auto;color:var(--content-tertiary);font:normal var(--font-size-xs) var(--font-mono)}.column-dot{width:7px;height:7px;border-radius:var(--radius-pill)}
.sample-project-card{position:relative;min-height:105px;overflow:hidden;margin-bottom:var(--space-sm);border:1px solid var(--project-card-border);border-radius:var(--project-card-radius);corner-shape:squircle;background:linear-gradient(to right,var(--project-card-gradient-start) 0%,var(--project-card-gradient-end) 40%),var(--project-color);box-shadow:var(--project-card-shadow);will-change:transform;transition:var(--project-card-motion)}.sample-project-card::before,.sample-project-card::after{content:'';position:absolute;inset:0;border-radius:inherit;corner-shape:squircle;pointer-events:none}.sample-project-card::before{background:var(--project-card-sheen-rest);box-shadow:inset 0 1px 0 var(--project-card-highlight-rest)}.sample-project-card::after{opacity:0;background:var(--project-card-sheen-hover);box-shadow:inset 0 1px 0 var(--project-card-highlight-hover);transition:opacity .25s ease}.sample-project-card:hover{transform:translateY(-2px);border-color:var(--project-card-hover-border);box-shadow:var(--project-card-hover-shadow)}.sample-project-card:hover::after{opacity:1}.sample-project-card:active{transform:translateY(1px);opacity:.93}.card-copy{position:relative;z-index:1;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-sm)}.card-name-row,.card-meta,.card-footer{display:flex;align-items:center;justify-content:space-between;gap:var(--space-xs)}.card-name-row strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--font-size-md);font-weight:var(--font-weight-medium)}.stars{color:var(--action-primary);font-size:var(--font-size-xs);letter-spacing:-.08em}.card-meta,.card-footer{font-size:var(--font-size-xs);color:var(--content-secondary)}.stage-chip{padding:1px var(--space-xs);border-radius:var(--radius-pill);background:var(--surface-soft)}.card-footer>span:first-child{display:flex;align-items:center;gap:var(--space-xs)}.seg-progress{height:4px;display:flex;gap:2px}.seg-progress i{flex:1;border-radius:var(--radius-pill);background:var(--surface-soft-hover)}.seg-progress i.done{background:var(--project-color)}.add-project{width:100%;height:30px;display:flex;align-items:center;justify-content:center;gap:var(--space-xs);border:1px dashed var(--border-subtle);border-radius:var(--radius-sm);color:var(--content-tertiary);background:transparent;font:var(--font-size-xs) var(--font-sans)}
.sample-gugu-fab{position:absolute;right:var(--floating-edge);bottom:var(--floating-edge);z-index:16;width:var(--gugu-fab-size);height:var(--gugu-fab-size);display:grid;place-items:center;border:1px solid var(--gugu-fab-border);border-radius:var(--radius-pill);color:#fff;background:var(--gugu-fab-bg);box-shadow:var(--gugu-fab-shadow);cursor:pointer;transition:transform .2s ease,box-shadow .2s ease}.sample-gugu-fab:hover{transform:scale(1.08);box-shadow:var(--gugu-fab-hover-shadow)}

.subsection{margin-top:var(--space-xl)}.first-subsection{margin-top:0}.subheading,.radius-title{display:flex;align-items:baseline;gap:var(--space-md);margin-bottom:var(--space-md)}.subheading h3,.radius-title h3{font-size:var(--font-size-md)}.subheading p,.radius-title p{font-size:var(--font-size-xs);color:var(--content-tertiary)}.token-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--design-grid-gap)}.token-card{min-width:0;border:1px solid var(--design-card-border);border-radius:var(--design-card-radius);background:var(--design-card-bg);box-shadow:var(--elevation-card)}.color-card{overflow:hidden}.color-swatch{height:76px;border-bottom:1px solid var(--border-hairline)}.compact-colors .color-swatch{height:56px}.token-meta{padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-xs)}.token-meta strong,.case-meta strong{font-size:var(--font-size-sm)}.token-meta code,.case-meta code,.type-meta code,.space-row code,.radius-item code,.contract-card code,.index-card code{color:var(--selection-fg);font:var(--font-size-xs)/var(--line-height-ui) var(--font-mono);overflow-wrap:anywhere}.token-meta span,.case-meta span{color:var(--content-tertiary);font-size:var(--font-size-xs)}
.foundation-split{display:grid;grid-template-columns:1.15fr .85fr;gap:var(--design-grid-gap);margin-top:var(--space-xl)}.foundation-panel{padding:var(--space-lg);border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--surface-soft)}.type-row{min-height:62px;display:grid;grid-template-columns:1fr 180px;align-items:center;gap:var(--space-lg);border-top:1px solid var(--border-hairline)}.type-row:first-child{border-top:0}.type-sample{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.type-meta,.radius-item{display:flex;flex-direction:column;gap:var(--space-xs)}.type-meta strong{font-size:var(--font-size-sm)}.type-meta small,.radius-item small{font-size:var(--font-size-xs);color:var(--content-tertiary)}.space-list{display:flex;flex-direction:column;gap:var(--space-sm)}.space-row{display:grid;grid-template-columns:110px 1fr 40px;align-items:center;gap:var(--space-sm)}.space-bar{height:7px;border-radius:var(--radius-pill);background:var(--action-primary)}.space-row em{font:normal var(--font-size-xs) var(--font-mono);color:var(--content-tertiary)}.radius-title{margin-top:var(--space-xl);padding-top:var(--space-lg);border-top:1px solid var(--border-hairline)}.radius-row{display:grid;grid-template-columns:repeat(5,1fr);gap:var(--space-sm)}.radius-item>span{width:42px;height:32px;border:1px solid var(--border-default);background:var(--selection-bg)}
.semantic-groups{display:flex;flex-direction:column;gap:var(--space-md)}.semantic-group{padding:var(--space-lg);border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--surface-soft)}.semantic-group>header{display:flex;justify-content:space-between;margin-bottom:var(--space-md)}.semantic-group h3{font-size:var(--font-size-md)}.semantic-group p{margin-top:var(--space-xs);font-size:var(--font-size-xs);color:var(--content-tertiary)}.semantic-group>header>span{font:var(--font-size-xs) var(--font-mono);color:var(--content-tertiary)}.semantic-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-sm)}.semantic-card{overflow:hidden}.semantic-demo{height:78px;padding:var(--space-md);display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-hairline);background:var(--surface-soft)}.surface-demo{width:100%;height:100%;display:grid;place-items:center;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);font-size:var(--font-size-xs)}.text-demo{width:100%;font-size:var(--font-size-md);font-weight:var(--font-weight-medium)}.border-demo{width:100%;height:40px;display:flex;align-items:center;padding:0 var(--space-sm);border:1px solid;border-radius:var(--radius-sm);background:var(--surface-raised);font-size:var(--font-size-xs);color:var(--content-tertiary)}.action-demo{height:34px;padding:0 var(--space-md);border:0;border-radius:var(--radius-sm);color:#fff;font:var(--font-weight-medium) var(--font-size-sm) var(--font-sans)}.status-demo{display:inline-flex;align-items:center;gap:var(--space-xs);padding:var(--space-xs) var(--space-sm);border-radius:var(--radius-pill);font-size:var(--font-size-sm)}.status-demo i{width:6px;height:6px;border-radius:var(--radius-pill)}
.elevation-grid,.component-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--design-grid-gap)}.elevation-case{min-height:230px;padding:var(--space-lg);display:flex;flex-direction:column;justify-content:center;gap:var(--space-lg);border:1px solid var(--border-hairline);border-radius:var(--radius-md);background:var(--surface-soft)}.mini-project{position:relative;min-height:88px;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-sm);overflow:hidden;border:1px solid var(--project-card-border);border-radius:var(--project-card-radius);background:linear-gradient(to right,var(--project-card-gradient-start) 0%,var(--project-card-gradient-end) 40%),var(--project-color);box-shadow:var(--project-card-shadow)}.mini-project strong,.mini-project span{position:relative;z-index:1}.mini-project span{font-size:var(--font-size-sm);color:var(--content-secondary)}.hover-case{transform:translateY(-2px);box-shadow:var(--project-card-hover-shadow)}.mini-popup{width:190px;align-self:center;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-sm);border:1px solid var(--popup-border);border-radius:var(--popup-radius);background:var(--popup-background);box-shadow:var(--elevation-popup)}.mini-popup span{font-size:var(--font-size-sm);color:var(--content-secondary)}.mini-popup button{padding:var(--space-xs);border:0;border-radius:var(--radius-xs);color:var(--action-primary);background:var(--action-soft)}.mini-chat{width:190px;height:90px;align-self:center;display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-md);border:1px solid var(--gugu-chat-border);border-radius:var(--gugu-chat-radius);background:var(--gugu-chat-bg);box-shadow:var(--gugu-chat-shadow)}.mini-chat>span{width:32px;height:32px;display:grid;place-items:center;border-radius:var(--radius-pill);color:#fff;background:var(--gugu-fab-bg)}.mini-chat div,.case-meta{display:flex;flex-direction:column;gap:var(--space-xs)}.mini-chat small{font-size:var(--font-size-xs);color:var(--content-tertiary)}
.contract-card{min-height:94px;display:flex;align-items:center;gap:var(--space-md);padding:var(--space-lg);border:1px solid var(--design-card-border);border-radius:var(--design-card-radius);background:var(--design-card-bg)}.contract-icon{width:38px;height:38px;display:grid;place-items:center;flex-shrink:0;border-radius:var(--radius-sm);color:var(--action-primary);background:var(--action-soft)}.contract-icon.gugu{color:#fff;background:var(--gugu-fab-bg)}.contract-card div{display:flex;flex-direction:column;gap:var(--space-xs)}.contract-card strong{font-size:var(--font-size-sm)}.contract-card small{font-size:var(--font-size-xs);color:var(--content-tertiary)}
.index-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--design-grid-gap)}.index-group{padding:var(--space-md);border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--surface-soft)}.index-group header{display:flex;justify-content:space-between;margin-bottom:var(--space-sm)}.index-group h3{font-size:var(--font-size-sm)}.index-group header span{font:var(--font-size-xs) var(--font-mono);color:var(--content-tertiary)}.index-grid{display:flex;flex-direction:column;gap:var(--space-xs)}.index-card{min-height:38px;padding:var(--space-sm);display:flex;align-items:center;justify-content:space-between;box-shadow:none}.index-dot{width:18px;height:18px;border:1px solid var(--border-subtle);border-radius:var(--radius-xs)}
@media(max-width:1100px){.theme-matrix,.token-grid,.semantic-grid,.elevation-grid,.component-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.index-groups{grid-template-columns:1fr}.sample-sidebar{width:188px}.product-frame{grid-template-columns:188px 1fr}.sample-search{display:none}}
@media(max-width:760px){.design-hero{position:relative;flex-direction:column;align-items:flex-start}.hero-copy p{white-space:normal}.theme-matrix,.token-grid,.semantic-grid,.elevation-grid,.component-strip{grid-template-columns:1fr}.foundation-split{grid-template-columns:1fr}.product-frame{grid-template-columns:1fr}.sample-sidebar{display:none}.sample-board{grid-template-columns:repeat(4,220px);overflow-x:auto}.sample-topbar{left:var(--space-md);right:var(--space-md)}.sample-title span,.sample-ghost{display:none}.type-row{grid-template-columns:1fr;padding:var(--space-sm) 0}.radius-row{grid-template-columns:repeat(3,1fr)}}
</style>
