const filesyncAdminUiBase = {
  'zh-CN': { title: '文件同步运行状态', description: '查看本地目录同步绑定、journal、冲突和事件 outbox；扫描与恢复不会读取文件正文。', autoSync: '自动同步', autoSyncEnabled: '已开启，自动监听本地文件和文件夹', autoSyncDisabled: '已关闭，仅保留手动对账', autoSyncUnsupported: '当前存储或沙盒模式不支持', toggleAutoSync: '切换文件自动同步', loading: '加载中…', refresh: '刷新', localReady: '本地文件同步可用', independentMode: '当前为独立存储/沙盒模式，不进入本地同步队列', backend: '存储后端', feature: '功能开关', enabled: '已开启', disabled: '已关闭', bindings: '绑定', pending: '待处理 journal', conflicts: '待处理冲突', outbox: '待投递事件', ignoredBindings: '当前模式忽略 {count} 个历史绑定，不会挂载或同步它们。', bindingList: '同步绑定', bindingStats: '显示 {shown} / 共 {total}', onlyIssues: '只看异常', allHealthy: '所有绑定运行正常，没有待处理 journal、失败或冲突；需要排查特定绑定时可关闭「只看异常」。', revision: 'revision', conflictCount: '冲突', dryRun: '预览', reconcile: '执行对账', working: '处理中…', dryRunResult: '预览：扫描 {scanned} 项，新增 {created}，更新 {updated}，拒绝 {rejected}，冲突 {conflicts}。', conflictList: '待处理冲突', bindingRef: '绑定', keepLocal: '保留本地', keepRemote: '保留云端', keepBoth: '保留双方', cancelConflict: '取消冲突', failures: '失败与重试', recoveryHint: '孤儿导入/删除仍在下方“存储对象 ↔ File 记录”对账区逐项确认；本面板不会自动删除物理对象。', reconcileTitle: '执行文件同步对账', reconcileConfirm: '将按当前绑定重新扫描并更新文件元数据，不自动删除物理文件。继续吗？', resolveTitle: '处理同步冲突', resolveConfirm: '该操作会改变绑定目录中的文件结果，请确认已检查双方内容。', confirmResolve: '确认处理' },
  'ja-JP': { title: 'ファイル同期の状態', description: 'ローカル同期、journal、競合、イベント outbox を確認します。本文は読み取りません。', autoSync: '自動同期', autoSyncEnabled: '有効。ローカルのファイルとフォルダーを自動監視', autoSyncDisabled: '無効。手動照合のみ', autoSyncUnsupported: '現在のストレージまたはサンドボックスでは未対応', toggleAutoSync: 'ファイル自動同期を切り替え', loading: '読み込み中…', refresh: '更新', localReady: 'ローカル同期を利用できます', independentMode: '独立ストレージ／サンドボックスモードです', backend: 'ストレージ', feature: '機能', enabled: '有効', disabled: '無効', bindings: 'バインド', pending: '保留 journal', conflicts: '競合', outbox: 'outbox', ignoredBindings: '現在のモードでは履歴バインド {count} 件を無視します。', bindingList: '同期バインド', bindingStats: '{total} 件中 {shown} 件を表示', onlyIssues: '異常のみ', allHealthy: 'すべてのバインドは正常です。保留 journal・失敗・競合はありません。特定のバインドを調べる場合は「異常のみ」をオフにしてください。', revision: 'revision', conflictCount: '競合', dryRun: 'プレビュー', reconcile: '照合を実行', working: '処理中…', dryRunResult: 'プレビュー：{scanned} 件を走査、新規 {created}、更新 {updated}、拒否 {rejected}、競合 {conflicts}。', conflictList: '保留中の競合', bindingRef: 'バインド', keepLocal: 'ローカルを保持', keepRemote: 'リモートを保持', keepBoth: '両方を保持', cancelConflict: '競合をキャンセル', failures: '失敗と再試行', recoveryHint: '孤児の取り込み／削除は下の照合欄で個別に確認します。自動削除はしません。', reconcileTitle: 'ファイル同期を照合', reconcileConfirm: '現在のバインドを再走査し、メタデータを更新します。物理ファイルは自動削除しません。続行しますか？', resolveTitle: '同期競合を処理', resolveConfirm: 'バインド先の結果が変わります。双方を確認してから続行してください。', confirmResolve: '処理を確認' },
  'en-US': { title: 'File sync status', description: 'Inspect local bindings, journals, conflicts, and the event outbox without reading file contents.', autoSync: 'Automatic sync', autoSyncEnabled: 'Enabled; local files and folders are watched automatically', autoSyncDisabled: 'Disabled; only manual reconciliation remains', autoSyncUnsupported: 'Not supported by the current storage or sandbox mode', toggleAutoSync: 'Toggle automatic file sync', loading: 'Loading…', refresh: 'Refresh', localReady: 'Local file sync is available', independentMode: 'Independent storage/sandbox mode; local sync queue is disabled', backend: 'Storage', feature: 'Feature', enabled: 'Enabled', disabled: 'Disabled', bindings: 'Bindings', pending: 'Pending journals', conflicts: 'Conflicts', outbox: 'Pending events', ignoredBindings: 'This mode ignores {count} historical bindings; nothing is mounted or synced.', bindingList: 'Sync bindings', bindingStats: 'Showing {shown} of {total}', onlyIssues: 'Issues only', allHealthy: 'All bindings are healthy — no pending journals, failures, or conflicts. Turn off "Issues only" to inspect a specific binding.', revision: 'Revision', conflictCount: 'Conflicts', dryRun: 'Preview', reconcile: 'Reconcile', working: 'Working…', dryRunResult: 'Preview: scanned {scanned}, created {created}, updated {updated}, rejected {rejected}, conflicts {conflicts}.', conflictList: 'Pending conflicts', bindingRef: 'Binding', keepLocal: 'Keep local', keepRemote: 'Keep remote', keepBoth: 'Keep both', cancelConflict: 'Cancel conflict', failures: 'Failures and retries', recoveryHint: 'Orphan import/delete remains individually confirmed in the storage ↔ File reconciliation below; this panel never deletes physical objects automatically.', reconcileTitle: 'Reconcile file sync', reconcileConfirm: 'The binding will be rescanned and metadata updated. Physical files will not be deleted automatically. Continue?', resolveTitle: 'Resolve sync conflict', resolveConfirm: 'This changes the result in the bound directory. Check both sides before continuing.', confirmResolve: 'Confirm resolution' },
} as const

Object.assign(filesyncAdminUiBase['zh-CN'], {
  watcherHealth: '监听状态：{status}',
  manualReconcileNeeded: '可能存在未同步变化，请手动核对',
  noManualReconcileNeeded: '暂无已知监听缺口',
})
Object.assign(filesyncAdminUiBase['ja-JP'], {
  watcherHealth: '監視状態：{status}',
  manualReconcileNeeded: '未同期の変更がある可能性があります。手動照合してください',
  noManualReconcileNeeded: '既知の監視ギャップはありません',
})
Object.assign(filesyncAdminUiBase['en-US'], {
  watcherHealth: 'Watcher status: {status}',
  manualReconcileNeeded: 'Changes may be unsynced; run a manual reconciliation',
  noManualReconcileNeeded: 'No known watcher gaps',
})

export const filesyncAdminUi = filesyncAdminUiBase

export const filesyncUserUi = {
  'zh-CN': {
    open: '文件同步核对', title: '文件同步核对',
    description: '实时同步仍由监听处理；这里仅手动预检或核对，不会自动执行整树扫描。',
    refresh: '刷新', loading: '正在读取同步状态…', bindings: '本地目录绑定',
    noBinding: '尚无本地目录绑定。先对默认个人目录进行只读预检，确认范围和结果后再初始化。',
    previewDefault: '预检默认个人目录', preview: '预检', reconcile: '执行核对', initialize: '初始化导入',
    binding: '绑定 #{id}', watcher: '监听：{status}', needsReconcile: '可能有未同步变化，请手动核对',
    noKnownGap: '暂无已知监听缺口', allowDelete: '允许把扫描确认缺失的文件库记录移入回收站',
    recentRuns: '最近任务', noRuns: '暂无核对任务', working: '处理中…', taskQueued: '任务已提交，可在下方查看进度与结果。',
    stage: '阶段：{stage}', scanned: '已扫描 {count} 项',
    results: '新增 {created} · 更新 {updated} · 移动 {moved} · 删除 {deleted} · 跳过 {skipped} · 冲突 {conflicts} · 失败 {failed}',
    error: '错误码：{code}', partialResult: '任务中止前已有部分变更提交；不会整轮回滚。可核对结果后重新发起。',
    cancelRun: '取消任务', cancelTitle: '取消文件同步任务', cancelConfirm: '任务会在当前扫描/投影安全点停止，已提交的批次会保留。继续吗？',
    initializeTitle: '初始化本地目录', initializeConfirm: '将把默认个人目录中的历史文件显式导入文件库；本次不会删除文件库记录。确认目录范围后继续。',
    reconcileTitle: '执行文件同步核对', reconcileConfirm: '将扫描此绑定并更新已确认的文件变化，不会删除缺失记录。继续吗？',
    reconcileDeleteConfirm: '将扫描此绑定；完整扫描确认缺失后，文件库记录可能移入回收站。物理文件不会被扫描任务删除。确认继续吗？',
    status: { queued: '排队中', running: '运行中', cancelling: '正在取消', succeeded: '已完成', failed: '失败', cancelled: '已取消' },
    action: { dry_run: '预检', repair: '修复核对', initialize: '初始化导入', mirror_out: '文件库导出' },
    stageName: { unknown: '等待开始', scanning: '扫描', comparing: '比较', projecting: '投影', finished: '结束', failed: '结束', cancelled: '结束' },
  },
  'ja-JP': {
    open: 'ファイル同期を確認', title: 'ファイル同期の確認',
    description: '通常のリアルタイム同期は監視が処理します。ここでは手動確認のみ行います。',
    refresh: '更新', loading: '同期状態を読み込み中…', bindings: 'ローカルディレクトリ',
    noBinding: 'ローカルバインドがありません。まず個人ディレクトリを読み取り専用でプレビューし、範囲と結果を確認してください。',
    previewDefault: '個人ディレクトリをプレビュー', preview: 'プレビュー', reconcile: '照合', initialize: '初期インポート',
    binding: 'バインド #{id}', watcher: '監視：{status}', needsReconcile: '未同期の変更がある可能性があります。手動照合してください',
    noKnownGap: '既知の監視ギャップはありません', allowDelete: '完全スキャンで確認された欠損レコードをゴミ箱へ移動する',
    recentRuns: '最近のタスク', noRuns: '照合タスクはありません', working: '処理中…', taskQueued: 'タスクを登録しました。下に進行状況と結果が表示されます。',
    stage: '段階：{stage}', scanned: '{count} 件をスキャン',
    results: '新規 {created} · 更新 {updated} · 移動 {moved} · 削除 {deleted} · スキップ {skipped} · 競合 {conflicts} · 失敗 {failed}',
    error: 'エラーコード：{code}', partialResult: '中断前に一部の変更が確定しています。全体のロールバックはありません。',
    cancelRun: 'タスクをキャンセル', cancelTitle: '同期タスクをキャンセル', cancelConfirm: '安全なスキャン／投影境界で停止します。確定済みバッチは保持されます。続行しますか？',
    initializeTitle: 'ローカルディレクトリを初期化', initializeConfirm: '個人ディレクトリの既存ファイルを明示的にインポートします。ファイルライブラリの記録は削除しません。',
    reconcileTitle: 'ファイル同期を照合', reconcileConfirm: 'バインドをスキャンし、確認された変更を適用します。欠損記録は削除しません。',
    reconcileDeleteConfirm: '完全スキャンで欠損が確認された場合、ファイルライブラリの記録をゴミ箱へ移動することがあります。物理ファイルは削除しません。',
    status: { queued: '待機中', running: '実行中', cancelling: 'キャンセル中', succeeded: '完了', failed: '失敗', cancelled: 'キャンセル済み' },
    action: { dry_run: 'プレビュー', repair: '修復照合', initialize: '初期インポート', mirror_out: 'ライブラリのエクスポート' },
    stageName: { unknown: '開始待ち', scanning: 'スキャン', comparing: '比較', projecting: '反映', finished: '終了', failed: '終了', cancelled: '終了' },
  },
  'en-US': {
    open: 'File sync check', title: 'File sync check',
    description: 'The watcher continues handling live changes. This panel only starts explicit previews or reconciliations.',
    refresh: 'Refresh', loading: 'Loading sync state…', bindings: 'Local directory bindings',
    noBinding: 'No local binding exists. Start with a read-only preview of the default personal directory, then review its scope and results before initialization.',
    previewDefault: 'Preview personal directory', preview: 'Preview', reconcile: 'Reconcile', initialize: 'Initialize import',
    binding: 'Binding #{id}', watcher: 'Watcher: {status}', needsReconcile: 'Changes may be unsynced; run a manual reconciliation',
    noKnownGap: 'No known watcher gap', allowDelete: 'Move File records confirmed missing by a complete scan to trash',
    recentRuns: 'Recent tasks', noRuns: 'No reconciliation tasks', working: 'Working…', taskQueued: 'Task queued. Progress and results appear below.',
    stage: 'Stage: {stage}', scanned: 'Scanned {count}',
    results: 'Created {created} · Updated {updated} · Moved {moved} · Deleted {deleted} · Skipped {skipped} · Conflicts {conflicts} · Failed {failed}',
    error: 'Error code: {code}', partialResult: 'Some changes were committed before the task stopped; the whole run is not rolled back.',
    cancelRun: 'Cancel task', cancelTitle: 'Cancel file sync task', cancelConfirm: 'The task stops at a safe scan/projection boundary. Already committed batches remain. Continue?',
    initializeTitle: 'Initialize local directory', initializeConfirm: 'Explicitly import historical files from the default personal directory. This does not delete File records.',
    reconcileTitle: 'Reconcile file sync', reconcileConfirm: 'Scan this binding and apply confirmed file changes without deleting missing records. Continue?',
    reconcileDeleteConfirm: 'A complete scan may move confirmed-missing File records to trash. The scan will not delete physical files. Continue?',
    status: { queued: 'Queued', running: 'Running', cancelling: 'Cancelling', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled' },
    action: { dry_run: 'Preview', repair: 'Repair reconciliation', initialize: 'Initialize import', mirror_out: 'Library export' },
    stageName: { unknown: 'Waiting', scanning: 'Scanning', comparing: 'Comparing', projecting: 'Applying', finished: 'Finished', failed: 'Finished', cancelled: 'Finished' },
  },
} as const
