type LocaleMessages = Record<string, any>

export function applyGreetingPatches(messages: Record<'zh-CN' | 'ja-JP' | 'en-US', LocaleMessages>) {
  Object.assign(messages['zh-CN'], { greetingUi: { fallbacks: [
    '回来啦。\n这阵子忙的事，有进展就一起往前推，卡住了也别自己扛。\n想先理清点啥、推进点啥，还是随便聊聊？都行。',
    '咕咕在呢。\n该做的我帮你盯着，容易忘的我帮你记着，别让事情悄悄跑丢。\n今天想从哪件开始？不急也没关系。',
    '嘿，在的。\n不管是要推进的事、要理清的念头，还是想找个人说说，我都在。\n你说，我听着。',
    '来啦~\n手头那些要做的、要记的、要想明白的，交给我一起整。\n想先弄哪样，直接说就行。',
    '等你半天啦。\n这地方会慢慢攒下你做过、想过、聊过的东西。\n今天，想先做点啥、聊点啥？',
  ] } })
  Object.assign(messages['ja-JP'], { greetingUi: { fallbacks: [
    'おかえりなさい。\n最近のこと、進んでいても引っかかっていても、一緒に少しずつ進めよう。\nまずは何から話そうか？',
    '咕咕はここにいるよ。\n忘れそうなことも、考えを整理したいことも、一緒に見ていこう。\n今日は何から始めたい？',
    'やあ、いるよ。\n進めたいことでも、整理したい考えでも、ただ話したいだけでも大丈夫。\n聞かせて。',
    '来たよ。\nやることも、覚えておきたいことも、考えたいことも一緒に整えよう。\nどれからにする？',
    '待ってたよ。\nここには、やったことや考えたこと、話したことが少しずつ積み重なっていく。\n今日は何を話そうか？',
  ] } })
  Object.assign(messages['en-US'], { greetingUi: { fallbacks: [
    'Welcome back.\nWhatever has been moving or feeling stuck lately, we can take it forward together.\nWhat would you like to untangle first?',
    'Gugu is here.\nI can help keep an eye on what matters and hold onto the things that are easy to forget.\nWhere should we start today?',
    'Hey, I’m here.\nWhether you want to move something forward, clear your head, or simply talk, I’m listening.\nTell me what’s on your mind.',
    'Hi there~\nLet’s sort through the things you want to do, remember, or think through.\nWhich one should we pick up first?',
    'I’ve been here waiting for you.\nThis space will slowly gather what you’ve done, thought, and talked about.\nWhat would you like to talk about today?',
  ] } })
}
