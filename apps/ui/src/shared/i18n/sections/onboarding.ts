type LocaleMessages = Record<string, any>

export function applyOnboardingPatches(messages: Record<'zh-CN' | 'ja-JP' | 'en-US', LocaleMessages>) {
  Object.assign((messages['zh-CN'] as Record<string, any>).onboardingUi, { brand: '咕咕', apiKey: 'API Key', progress: '引导进度' })
  Object.assign((messages['ja-JP'] as Record<string, any>).onboardingUi, { brand: 'グーグー', apiKey: 'API Key', progress: 'ガイドの進行状況' })
  Object.assign((messages['en-US'] as Record<string, any>).onboardingUi, { brand: 'Gugu', apiKey: 'API key', progress: 'Guide progress' })
  Object.assign((messages['zh-CN'] as Record<string, any>).onboardingUi, { modelSettings: '模型设置', style: { mode: '显示模式', glass: 'Aero 毛玻璃', glassHint: '轻盈通透，适合日常工作', mono: 'Mono 素雅', monoHint: '克制清晰，突出内容' } })
  Object.assign((messages['ja-JP'] as Record<string, any>).onboardingUi, { modelSettings: 'モデル設定', style: { mode: '表示モード', glass: 'Aero ガラス', glassHint: '軽やかで透明感のある表示', mono: 'Mono シンプル', monoHint: '内容を引き立てる簡潔な表示' } })
  Object.assign((messages['en-US'] as Record<string, any>).onboardingUi, { modelSettings: 'Model settings', style: { mode: 'Display mode', glass: 'Aero glass', glassHint: 'Light and translucent for everyday work', mono: 'Mono minimal', monoHint: 'Quiet and focused on content' } })
  Object.assign((messages['zh-CN'] as Record<string, any>).onboardingUi.steps, { style: '选择样式' })
  Object.assign((messages['ja-JP'] as Record<string, any>).onboardingUi.steps, { style: '表示スタイル' })
  Object.assign((messages['en-US'] as Record<string, any>).onboardingUi.steps, { style: 'Choose a style' })
  Object.assign((messages['zh-CN'] as Record<string, any>).onboardingUi.copy, { style: '选择你喜欢的显示样式，之后也可以在个人设置中随时调整。' })
  Object.assign((messages['ja-JP'] as Record<string, any>).onboardingUi.copy, { style: '好みの表示スタイルを選択してください。個人設定からいつでも変更できます。' })
  Object.assign((messages['en-US'] as Record<string, any>).onboardingUi.copy, { style: 'Choose the display style you prefer. You can change it anytime in Personal settings.' })
  Object.assign((messages['zh-CN'] as Record<string, any>).onboardingUi.demo, { style: { chrome: '显示设置', screen: '样式预览', title: '选择你的风格', description: '样式会立即应用' } })
  Object.assign((messages['ja-JP'] as Record<string, any>).onboardingUi.demo, { style: { chrome: '表示設定', screen: 'スタイルプレビュー', title: 'スタイルを選択', description: '選択はすぐに反映されます' } })
  Object.assign((messages['en-US'] as Record<string, any>).onboardingUi.demo, { style: { chrome: 'Display settings', screen: 'Style preview', title: 'Choose your style', description: 'Your choice applies immediately' } })
}
