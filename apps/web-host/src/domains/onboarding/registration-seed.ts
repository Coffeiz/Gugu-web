/** 注册后首用数据播种。持久化操作由 Host 适配既有 Local 文件与 PostgreSQL 契约。 */
export type OnboardingLocale = 'zh-CN' | 'ja-JP' | 'en-US'

export interface RegistrationSeedFile {
  readonly space: 'project' | 'personal'
  readonly projectRef: 'seed_project' | null
  readonly displayName: string
  readonly ext: 'md' | 'mp3'
  readonly mimeType: 'text/markdown' | 'audio/mpeg'
  readonly data: Uint8Array
}

export interface RegistrationSeedPlan {
  readonly project: {
    name: string
    status: 'active'
    currentStage: string
    startDate: string
    deadline: string
    stages: Array<{ key: string; label: string; todos: Array<{ id: string; text: string; done: false }> }>
  }
  readonly calendarEvent: { title: string; date: string; type: 'event' }
  readonly files: readonly [RegistrationSeedFile, RegistrationSeedFile, ...RegistrationSeedFile[]]
  readonly seedState: { seeded: true; project_name: string }
  readonly guideState: {
    enabled: true
    version: 1
    current_step: 'locale'
    completed_steps: readonly []
    dismissed: false
    completed_at: null
  }
}

export interface RegistrationSeedPorts {
  /**
   * Host must atomically check onboarding_state.seed.seeded under a row lock, then write
   * the project, calendar event, file metadata and state in one PG transaction. Local file
   * writes must use the existing Local storage contract and be compensated on rollback.
   * The orchestrator deliberately exposes no per-row mutation ports.
   */
  applySeed(ownerId: string, plan: RegistrationSeedPlan): Promise<'applied' | 'already_seeded'>
  surpriseMp3(): Promise<{ name: string; data: Uint8Array } | null>
  onFailure?(error: unknown): void
}

type SeedContent = {
  projectNames: string[]
  stageLabels: string[][]
  stageTodos: string[][]
  welcomeFiles: Array<{ title: string; body: string }>
  scratchTitle: string
  scratchBodies: string[]
  calendarTitle: string
}

const content: Record<OnboardingLocale, SeedContent> = {
  'zh-CN': {
    projectNames: ['从这里开始', '第一份记录', '初次见面'],
    stageLabels: [['🌱 这里还有一点空', '🌱 目前还空空的'], ['🌿 慢慢有样子了', '🌿 开始丰富起来了', '🌿 有点像样了'], ['💬 找我聊聊吧']],
    stageTodos: [['随便逛逛', '建个项目试试'], ['去日历看看', '去文件库看看'], ['我就在右下角 😊', '加个 QQ 好友吧（飞书也行📪）']],
    welcomeFiles: [
      { title: '给未来的自己', body: '# 给未来的自己\n\n> 希望以后有一天，\n> 这里会放满你的想法、计划，\n> 还有很多很多聊天记录。\n\n不过今天，我们先从这一页开始 🌱\n\n---\n\n*—— 咕咕*\n' },
      { title: '第一份记录', body: '# 第一份记录\n\n> 每个人都会有第一份记录，\n> 今天这一页，属于咱们。\n\n以后这里会慢慢放满你的想法、计划，还有很多很多聊天 😊\n\n---\n\n*—— 咕咕*\n' },
    ],
    scratchTitle: '可以删掉我',
    scratchBodies: [
      '# 可以删掉我\n\n我只是一个示例文件 😊\n\n留着、改掉，或者删掉，都可以。\n\n> 💡 对啦，以后想删除整个项目，**项目卡右下角**就能找到删除按钮。\n',
      '# 可以删掉我\n\n放心折腾，删掉也不会惹我生气 😊\n\n> 💡 以后想删除整个项目，**右下角**就能找到入口。\n',
    ],
    calendarTitle: '和咕咕的第一天',
  },
  'ja-JP': {
    projectNames: ['ここから始める', '最初の記録', 'はじめまして'],
    stageLabels: [['🌱 まだ空っぽ', '🌱 まだ何もない'], ['🌿 少しずつ形に', '🌿 だんだん豊かに', '🌿 いい感じになってきた'], ['💬 話しかけてね']],
    stageTodos: [['少し見て回る', 'プロジェクトを作ってみる'], ['カレンダーを見る', 'ファイル庫を見る'], ['右下にいるよ 😊', 'QQで友だちになる（FeishuでもOK📪）']],
    welcomeFiles: [
      { title: '未来の自分へ', body: '# 未来の自分へ\n\n> いつかここが、\n> 思いつきや予定、\n> たくさんの会話でいっぱいになりますように。\n\n今日はこのページから始めよう 🌱\n\n---\n\n*—— グーグー*\n' },
      { title: '最初の記録', body: '# 最初の記録\n\n> 誰にでも最初の記録があります。\n> 今日のこのページは、私たちのもの。\n\nここは少しずつ、思いつきや予定、会話でいっぱいになります 😊\n\n---\n\n*—— グーグー*\n' },
    ],
    scratchTitle: '削除しても大丈夫',
    scratchBodies: ['# 削除しても大丈夫\n\nこれはサンプルファイルです 😊\n\n残しても、書き換えても、削除しても大丈夫。\n', '# 削除しても大丈夫\n\n気軽に試してみてね。削除しても怒らないよ 😊\n'],
    calendarTitle: 'グーグーとの最初の日',
  },
  'en-US': {
    projectNames: ['Start here', 'First record', 'Nice to meet you'],
    stageLabels: [['🌱 Still open', '🌱 Nothing here yet'], ['🌿 Taking shape', '🌿 Starting to grow', '🌿 Looking good'], ['💬 Come chat with me']],
    stageTodos: [['Take a look around', 'Try creating a project'], ['Check the calendar', 'Check the file library'], ['I’m in the bottom-right 😊', 'Add me on QQ (Feishu works too 📪)']],
    welcomeFiles: [
      { title: 'To my future self', body: '# To my future self\n\n> May this space one day be filled\n> with ideas, plans,\n> and many conversations.\n\nFor today, let’s start with this page 🌱\n\n---\n\n*—— Gugu*\n' },
      { title: 'First record', body: '# First record\n\n> Everyone has a first record.\n> This page belongs to us.\n\nLittle by little, this space will fill with ideas, plans, and chats 😊\n\n---\n\n*—— Gugu*\n' },
    ],
    scratchTitle: 'You can delete me',
    scratchBodies: ['# You can delete me\n\nI’m just a sample file 😊\n\nKeep, edit, or delete me—anything is fine.\n', '# You can delete me\n\nFeel free to experiment. I won’t mind if you delete me 😊\n'],
    calendarTitle: 'Our first day together',
  },
}

function pick<T>(items: readonly T[], random: () => number): T {
  const sampled = random()
  const index = Number.isFinite(sampled)
    ? Math.max(0, Math.min(items.length - 1, Math.floor(sampled * items.length)))
    : 0
  const value = items[index]
  if (value === undefined) throw new Error('新用户引导内容为空')
  return value
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dateKeyPlusDays(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** 注册事务已提交后调用；任何播种失败都不得影响注册结果。 */
export function createRegistrationSeeder(ports: RegistrationSeedPorts, options: {
  now?: () => Date
  random?: () => number
} = {}) {
  const now = options.now ?? (() => new Date())
  const random = options.random ?? Math.random
  return async function seed(ownerId: string, locale?: string | null): Promise<void> {
    try {
      const key = dateKey(now())
      const selected = content[locale as OnboardingLocale] ?? content['zh-CN']
      const name = pick(selected.projectNames, random)
      const stages = selected.stageLabels.map((labels, i) => ({
        key: `s${i}`,
        label: pick(labels, random),
        todos: selected.stageTodos[i]!.map((text, j) => ({ id: `s${i}t${j}`, text, done: false as const })),
      }))
      const welcome = pick(selected.welcomeFiles, random)
      const files: RegistrationSeedFile[] = [{
        space: 'project', projectRef: 'seed_project', displayName: welcome.title,
        ext: 'md', mimeType: 'text/markdown', data: Buffer.from(welcome.body, 'utf8'),
      }, {
        space: 'project', projectRef: 'seed_project', displayName: selected.scratchTitle,
        ext: 'md', mimeType: 'text/markdown', data: Buffer.from(pick(selected.scratchBodies, random), 'utf8'),
      }]
      const surprise = await ports.surpriseMp3()
      if (surprise) files.push({
        space: 'personal', projectRef: null, displayName: surprise.name,
        ext: 'mp3', mimeType: 'audio/mpeg', data: surprise.data,
      })
      await ports.applySeed(ownerId, {
        project: {
          name, status: 'active', currentStage: stages[0]!.key,
          startDate: key, deadline: dateKeyPlusDays(key, 3), stages,
        },
        calendarEvent: { title: selected.calendarTitle, date: key, type: 'event' },
        files: files as [RegistrationSeedFile, RegistrationSeedFile, ...RegistrationSeedFile[]],
        seedState: { seeded: true, project_name: name },
        guideState: {
          enabled: true, version: 1, current_step: 'locale',
          completed_steps: [], dismissed: false, completed_at: null,
        },
      })
    } catch (error) {
      try { ports.onFailure?.(error) } catch { /* best-effort diagnostics */ }
    }
  }
}
