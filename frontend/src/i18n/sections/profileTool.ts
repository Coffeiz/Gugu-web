type LocaleMessages = Record<string, any>

export function applyProfileToolSection(messages: Record<'zh-CN' | 'ja-JP' | 'en-US', LocaleMessages>) {
  Object.assign((messages['zh-CN'] as Record<string, any>).profileToolUi, { smtpEnabled: '启用个人 SMTP' })
  Object.assign((messages['ja-JP'] as Record<string, any>).profileToolUi, { smtpEnabled: '個人 SMTP を有効化' })
  Object.assign((messages['en-US'] as Record<string, any>).profileToolUi, { smtpEnabled: 'Enable personal SMTP' })
  Object.assign((messages['zh-CN'] as Record<string, any>).profileToolUi, { smtpTo: '测试收件人（默认注册邮箱）' })
  Object.assign((messages['ja-JP'] as Record<string, any>).profileToolUi, { smtpTo: 'テスト受信者（既定は登録メール）' })
  Object.assign((messages['en-US'] as Record<string, any>).profileToolUi, { smtpTo: 'Test recipient (defaults to account email)' })
  Object.assign((messages['ja-JP'] as Record<string, any>).profileToolUi, { smtpTitle: '個人 SMTP', smtpHint: '設定後はメールツールがこの SMTP を優先して使用します。テストメールは登録メールアドレスに送信されます。未設定時はサーバー既定の SMTP を使用します。', smtpHost: 'SMTP サーバー', smtpPort: 'ポート', smtpUser: 'アカウント', smtpPassword: 'パスワード', smtpPasswordKeep: '空欄で現在のパスワードを保持', smtpFrom: '差出人（任意）', smtpSsl: 'SSL/TLS', smtpTest: 'テストメールを送信', smtpSaved: 'SMTP 設定を保存しました', smtpSaveFailed: 'SMTP の保存に失敗しました', smtpTestFailed: 'SMTP テストに失敗しました', smtpTestPassed: 'テストメールを送信しました' })
  Object.assign((messages['en-US'] as Record<string, any>).profileToolUi, { smtpTitle: 'Personal SMTP', smtpHint: 'Email tools prefer this SMTP after it is configured. Test emails are sent to your registered email address. The server default SMTP is used when it is not configured.', smtpHost: 'SMTP server', smtpPort: 'Port', smtpUser: 'Account', smtpPassword: 'Password', smtpPasswordKeep: 'Leave blank to keep the current password', smtpFrom: 'From address (optional)', smtpSsl: 'SSL/TLS', smtpTest: 'Send test email', smtpSaved: 'SMTP configuration saved', smtpSaveFailed: 'Failed to save SMTP configuration', smtpTestFailed: 'SMTP test failed', smtpTestPassed: 'Test email sent' })
  Object.assign((messages['zh-CN'] as Record<string, any>).profileToolUi, { smtpTitle: '个人 SMTP', smtpHint: '配置后邮件工具优先使用此 SMTP；测试邮件会发送到你的注册邮箱。未配置时使用服务器默认 SMTP。', smtpHost: 'SMTP 服务器', smtpPort: '端口', smtpUser: '账号', smtpPassword: '密码', smtpPasswordKeep: '留空则保留当前密码', smtpFrom: '发件人（可选）', smtpSsl: 'SSL/TLS', smtpTest: '发送测试邮件', smtpSaved: 'SMTP 配置已保存', smtpSaveFailed: 'SMTP 保存失败', smtpTestFailed: 'SMTP 测试失败' })
  Object.assign((messages['zh-CN'] as Record<string, any>).profileToolUi, { smtpTestPassed: '测试邮件已发送' })
}
