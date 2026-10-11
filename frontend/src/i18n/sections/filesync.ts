const filesyncAdminUiBase = {
  'zh-CN': { title: '文件同步运行状态', description: '查看本地目录同步绑定、journal、冲突和事件 outbox；扫描与恢复不会读取文件正文。', autoSync: '自动同步', autoSyncEnabled: '已开启，自动监听本地文件和文件夹', autoSyncDisabled: '已关闭，仅保留手动对账', autoSyncUnsupported: '当前存储或沙盒模式不支持', toggleAutoSync: '切换文件自动同步', loading: '加载中…', refresh: '刷新', localReady: '本地文件同步可用', independentMode: '当前为独立存储/沙盒模式，不进入本地同步队列', backend: '存储后端', feature: '功能开关', enabled: '已开启', disabled: '已关闭', bindings: '绑定', pending: '待处理 journal', conflicts: '待处理冲突', outbox: '待投递事件', ignoredBindings: '当前模式忽略 {count} 个历史绑定，不会挂载或同步它们。', bindingList: '同步绑定', bindingStats: '显示 {shown} / 共 {total}', onlyIssues: '只看异常', allHealthy: '所有绑定运行正常，没有待处理 journal、失败或冲突；需要排查特定绑定时可关闭「只看异常」。', queueIssues: '一键排入异常对账（{count}）', queueingIssues: '正在排队…', queueIssuesTitle: '排入异常绑定对账', queueIssuesConfirm: '将为 {count} 个当前异常的有效普通本地绑定排入完整修复核对。服务端会重新检查异常和绑定状态，已有排队任务会复用，已有未完成任务的绑定会跳过；任务按用户和系统并发规则执行。本操作不会删除物理文件或数据库记录，是否继续？', queueIssuesConfirmButton: '确认排入', queueIssuesResult: '异常绑定批量排队完成：队列中 {queued} 个，已有其他未完成任务跳过 {busy} 个，状态变化跳过 {skipped} 个（当前符合条件 {eligible} 个）。', revision: 'revision', conflictCount: '冲突', dryRun: '预览', reconcile: '执行对账', working: '处理中…', dryRunResult: '预览：扫描 {scanned} 项，新增 {created}，更新 {updated}，拒绝 {rejected}，冲突 {conflicts}。', conflictList: '待处理冲突', bindingRef: '绑定', keepLocal: '保留本地', keepRemote: '保留云端', keepBoth: '保留双方', cancelConflict: '取消冲突', bulkResolve: '全部{resolution}（{count}）', bulkResolveTitle: '批量处理全部待处理冲突', bulkResolveConfirm: '将对所有用户当前全部 {count} 条待处理冲突统一执行“{resolution}”。其中“保留云端”会覆盖绑定目录中的本地版本；“保留双方”会在本地另存云端副本，并逐条复核对应目录，冲突较多时可能耗时较长。此操作可能部分成功，继续吗？', bulkProgress: '处理中 {done}/{total}', bulkResolveResult: '批量处理完成：成功 {completed} 条，失败 {failed} 条。失败项仍可刷新后单独处理。', bulkListIncomplete: '当前仅加载 {shown} / {total} 条冲突。为避免误称“全部”，批量操作已禁用。', failures: '失败与重试', recoveryHint: '孤儿导入/删除仍在下方“存储对象 ↔ File 记录”对账区逐项确认；本面板不会自动删除物理对象。', reconcileTitle: '执行文件同步对账', reconcileConfirm: '将按当前绑定重新扫描并更新文件元数据，不自动删除物理文件。继续吗？', resolveTitle: '处理同步冲突', resolveConfirm: '该操作会改变绑定目录中的文件结果，请确认已检查双方内容。', confirmResolve: '确认处理' },
  'ja-JP': { title: 'ファイル同期の状態', description: 'ローカル同期、journal、競合、イベント outbox を確認します。本文は読みません。', autoSync: '自動同期', autoSyncEnabled: '有効。ローカルのファイルとフォルダーを自動監視', autoSyncDisabled: '無効。手動照合のみ', autoSyncUnsupported: '現在のストレージまたはサンドボックスでは未対応', toggleAutoSync: 'ファイル自動同期を切り替え', loading: '読み込み中…', refresh: '更新', localReady: 'ローカル同期を利用できます', independentMode: '独立ストレージ／サンドボックスモードです', backend: 'ストレージ', feature: '機能', enabled: '有効', disabled: '無効', bindings: 'バインド', pending: '保留 journal', conflicts: '競合', outbox: 'outbox', ignoredBindings: '現在のモードでは履歴バインド {count} 件を無視します。', bindingList: '同期バインド', bindingStats: '{total} 件中 {shown} 件を表示', onlyIssues: '異常のみ', allHealthy: 'すべてのバインドは正常です。保留 journal・失敗・競合はありません。特定のバインドを調べる場合は「異常のみ」をオフにしてください。', queueAll: 'すべての照合を一括登録（{count}）', queueingAll: '登録中…', queueAllTitle: 'すべての同期バインドを照合キューへ', queueAllConfirm: '表示や異常フィルターに関係なく、有効な通常ローカルバインド {count} 件を完全修復照合キューに登録します。既存の待機中タスクは再利用し、未完了タスクがあるバインドはスキップします。物理ファイルやデータベース記録は削除しません。続行しますか？', queueAllConfirmButton: 'キューに登録', queueAllResult: '一括登録完了：キュー内 {queued} 件、他の未完了タスクによりスキップ {busy} 件、状態変更でスキップ {skipped} 件（対象 {eligible} 件）。', revision: 'revision', conflictCount: '競合', dryRun: 'プレビュー', reconcile: '照合を実行', working: '処理中…', dryRunResult: 'プレビュー：{scanned} 件を走査、新規 {created}、更新 {updated}、拒否 {rejected}、競合 {conflicts}。', conflictList: '保留中の競合', bindingRef: 'バインド', keepLocal: 'ローカルを保持', keepRemote: 'リモートを保持', keepBoth: '両方を保持', cancelConflict: '競合をキャンセル', bulkResolve: 'すべて{resolution}（{count}）', bulkResolveTitle: '保留中のすべての競合を一括処理', bulkResolveConfirm: '保留中の {count} 件すべてに「{resolution}」を適用します。「リモートを保持」はローカル版を上書きし、「両方を保持」はリモート版のコピーを保存します。一部のみ成功する場合があります。続行しますか？', bulkProgress: '{done}/{total} 件を処理中', bulkResolveResult: '一括処理完了：成功 {completed} 件、失敗 {failed} 件。失敗した項目は更新後に個別処理できます。', bulkListIncomplete: '{total} 件中 {shown} 件のみ読み込まれています。「すべて」と誤認しないよう一括操作を無効にしました。', failures: '失敗と再試行', recoveryHint: '孤児の取り込み／削除は下の照合欄で個別に確認します。自動削除はしません。', reconcileTitle: 'ファイル同期を照合', reconcileConfirm: '現在のバインドを再走査し、メタデータを更新します。物理ファイルは自動削除しません。続行しますか？', resolveTitle: '同期競合を処理', resolveConfirm: 'バインド先の結果が変わります。双方を確認してから続行してください。', confirmResolve: '処理を確認' },
  'en-US': { title: 'File sync status', description: 'Inspect local bindings, journals, conflicts, and the event outbox without reading file contents.', autoSync: 'Automatic sync', autoSyncEnabled: 'Enabled; local files and folders are watched automatically', autoSyncDisabled: 'Disabled; only manual reconciliation remains', autoSyncUnsupported: 'Not supported by the current storage or sandbox mode', toggleAutoSync: 'Toggle automatic file sync', loading: 'Loading…', refresh: 'Refresh', localReady: 'Local file sync is available', independentMode: 'Independent storage/sandbox mode; local sync queue is disabled', backend: 'Storage', feature: 'Feature', enabled: 'Enabled', disabled: 'Disabled', bindings: 'Bindings', pending: 'Pending journals', conflicts: 'Conflicts', outbox: 'Pending events', ignoredBindings: 'This mode ignores {count} historical bindings; nothing is mounted or synced.', bindingList: 'Sync bindings', bindingStats: 'Showing {shown} of {total}', onlyIssues: 'Issues only', allHealthy: 'All bindings are healthy — no pending journals, failures, or conflicts. Turn off "Issues only" to inspect a specific binding.', queueAll: 'Queue all reconciliations ({count})', queueingAll: 'Queueing…', queueAllTitle: 'Queue all sync binding reconciliations', queueAllConfirm: 'Queue a full repair reconciliation for all {count} active ordinary local bindings, regardless of the current filter or visible rows. Existing queued tasks are reused and bindings with any unfinished task are skipped. This will not delete physical files or database records. Continue?', queueAllConfirmButton: 'Confirm queue', queueAllResult: 'Bulk queue complete: {queued} in queue, {busy} skipped because another task is unfinished, {skipped} skipped after status changed ({eligible} eligible).', revision: 'Revision', conflictCount: 'Conflicts', dryRun: 'Preview', reconcile: 'Reconcile', working: 'Working…', dryRunResult: 'Preview: scanned {scanned}, created {created}, updated {updated}, rejected {rejected}, conflicts {conflicts}.', conflictList: 'Pending conflicts', bindingRef: 'Binding', keepLocal: 'Keep local', keepRemote: 'Keep remote', keepBoth: 'Keep both', cancelConflict: 'Cancel conflict', bulkResolve: 'Apply {resolution} to all ({count})', bulkResolveTitle: 'Resolve all pending conflicts', bulkResolveConfirm: 'Apply “{resolution}” to all {count} pending conflicts. “Keep remote” overwrites the local version; “Keep both” saves a separate remote copy. Some items may fail while others succeed. Continue?', bulkProgress: 'Processing {done}/{total}', bulkResolveResult: 'Bulk resolution finished: {completed} succeeded, {failed} failed. Failed items remain available for individual handling after refresh.', bulkListIncomplete: 'Only {shown} of {total} conflicts are loaded. Bulk actions are disabled to avoid claiming this is “all”.', failures: 'Failures and retries', recoveryHint: 'Orphan import/delete remains individually confirmed in the storage ↔ File reconciliation below; this panel never deletes physical objects automatically.', reconcileTitle: 'Reconcile file sync', reconcileConfirm: 'The binding will be rescanned and metadata updated. Physical files will not be deleted automatically. Continue?', resolveTitle: 'Resolve sync conflict', resolveConfirm: 'This changes the result in the bound directory. Check both sides before continuing.', confirmResolve: 'Confirm resolution' },
} as const

Object.assign(filesyncAdminUiBase['zh-CN'], {
  watcherCapacityTitle: 'inotify 监听容量', watcherCapacityDescription: '按当前 Worker 的 Linux UID 统计；达到当前上限 80% 时自动扩容一档。',
  watcherManagerUnavailable: '宿主机扩容服务不可用；当前部署尚未连接受限的 Linux 管理服务。',
  watcherHardLimit: '硬上限', saveWatcherLimit: '保存上限', expandWatcherLimit: '立即扩容一档',
  watcherUid: 'Linux UID {uid}', watcherUsage: '使用 {usage} / {limit}', watcherPercent: '占用 {percent}%', watcherThreshold: '80% 扩容阈值 {count}', watcherAtWarning: '已达到 90% 告警线',
  watcherNextLimit: '下一档 {count}', watcherLastExpansion: '最近扩容 {time}', watcherNeverExpanded: '尚未扩容', watcherLimitInvalid: '硬上限需为 65536 到 1024000 的整数。',
})
Object.assign(filesyncAdminUiBase['ja-JP'], {
  watcherCapacityTitle: 'inotify 監視容量', watcherCapacityDescription: '現在の Worker の Linux UID を集計し、上限の 80% で自動的に 1 段階拡張します。',
  watcherManagerUnavailable: 'ホスト拡張サービスを利用できません。この環境は Linux 管理サービスに接続されていません。',
  watcherHardLimit: '上限', saveWatcherLimit: '上限を保存', expandWatcherLimit: '今すぐ 1 段階拡張',
  watcherUid: 'Linux UID {uid}', watcherUsage: '使用量 {usage} / {limit}', watcherPercent: '{percent}% 使用', watcherThreshold: '80% 拡張しきい値 {count}', watcherAtWarning: '90% の警告しきい値に到達',
  watcherNextLimit: '次の段階 {count}', watcherLastExpansion: '最終拡張 {time}', watcherNeverExpanded: '拡張履歴なし', watcherLimitInvalid: '上限は 65536～1024000 の整数です。',
})
Object.assign(filesyncAdminUiBase['en-US'], {
  watcherCapacityTitle: 'inotify watch capacity', watcherCapacityDescription: 'Counts watches for the Worker Linux UID; expands one tier at 80% of the current limit.',
  watcherManagerUnavailable: 'Host expansion service is unavailable; this deployment is not connected to the restricted Linux manager.',
  watcherHardLimit: 'Hard limit', saveWatcherLimit: 'Save limit', expandWatcherLimit: 'Expand one tier now',
  watcherUid: 'Linux UID {uid}', watcherUsage: 'Usage {usage} / {limit}', watcherPercent: '{percent}% used', watcherThreshold: '80% expansion threshold {count}', watcherAtWarning: '90% warning threshold reached',
  watcherNextLimit: 'Next tier {count}', watcherLastExpansion: 'Last expansion {time}', watcherNeverExpanded: 'Never expanded', watcherLimitInvalid: 'The hard limit must be an integer from 65536 to 1024000.',
})

Object.assign(filesyncAdminUiBase['zh-CN'], {
  queueAll: '一键排入全部对账（{count}）',
  queueingAll: '正在排队…',
  queueAllTitle: '排入全部同步绑定对账',
  queueAllConfirm: '将为全部 {count} 个有效普通本地绑定排入完整修复核对，不受当前筛选或可见行影响。已有排队任务会复用，存在未完成任务的绑定会跳过。本操作不会删除物理文件或数据库记录，是否继续？',
  queueAllConfirmButton: '确认排入',
  queueAllResult: '批量排队完成：队列中 {queued} 个，已有其他未完成任务跳过 {busy} 个，状态变化跳过 {skipped} 个（符合条件 {eligible} 个）。',
  watcherHealth: '监听状态：{status}',
  manualReconcileNeeded: '可能存在未同步变化，请手动核对',
  noManualReconcileNeeded: '暂无已知监听缺口',
})
Object.assign(filesyncAdminUiBase['ja-JP'], {
  queueIssues: '異常照合を一括登録（{count}）',
  queueingIssues: '登録中…',
  queueIssuesTitle: '異常バインドを照合キューへ',
  queueIssuesConfirm: '現在異常がある有効な通常ローカルバインド {count} 件を完全修復照合キューに登録します。サーバーが状態を再確認し、待機中のタスクは再利用、他の未完了タスクがあるバインドはスキップします。物理ファイルやデータベース記録は削除しません。続行しますか？',
  queueIssuesConfirmButton: 'キューに登録',
  queueIssuesResult: '異常バインドの一括登録完了：キュー内 {queued} 件、他の未完了タスクによりスキップ {busy} 件、状態変更でスキップ {skipped} 件（対象 {eligible} 件）。',
})
Object.assign(filesyncAdminUiBase['en-US'], {
  queueIssues: 'Queue anomalous bindings ({count})',
  queueingIssues: 'Queueing…',
  queueIssuesTitle: 'Queue anomalous sync bindings',
  queueIssuesConfirm: 'Queue a full repair reconciliation for {count} active ordinary local bindings currently reporting issues. The server rechecks each binding; queued repairs are reused and bindings with another unfinished task are skipped. This will not delete physical files or database records. Continue?',
  queueIssuesConfirmButton: 'Confirm queue',
  queueIssuesResult: 'Anomalous-binding queue complete: {queued} in queue, {busy} skipped because another task is unfinished, {skipped} skipped after status changed ({eligible} eligible).',
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
Object.assign(filesyncAdminUiBase['zh-CN'], {
  missingLocalConflictHint: '本地文件缺失：保留云端会尝试从文件库恢复到绑定目录；取消冲突会保留文件库记录并关闭此冲突。若要删除文件库记录，请在存储对账中单独确认。',
  bulkMissingLocalDisabled: '含本地文件缺失项：请逐项处理，批量操作已禁用。',
})
Object.assign(filesyncAdminUiBase['ja-JP'], {
  missingLocalConflictHint: 'ローカルファイルがありません。「リモートを保持」はファイルライブラリからバインド先への復元を試みます。「競合をキャンセル」はライブラリの記録を残して競合を閉じます。記録を削除する場合は、ストレージ照合で個別に確認してください。',
  bulkMissingLocalDisabled: 'ローカルファイルがない項目が含まれています。個別に処理してください。一括操作は無効です。',
})
Object.assign(filesyncAdminUiBase['en-US'], {
  missingLocalConflictHint: 'The local file is missing. “Keep remote” attempts to restore it from the file library to the bound directory; “Cancel conflict” keeps the library record and closes this conflict. To delete the library record, confirm it individually in Storage Reconciliation.',
  bulkMissingLocalDisabled: 'Some conflicts have no local file. Handle them individually; bulk actions are disabled.',
})

Object.assign(filesyncAdminUiBase['zh-CN'], {
  confirmMissingDelete: '确认缺失并删除记录',
  confirmMissingDeleteMessage: '将把文件库中对应的文件记录移入回收站，并记下已确认的删除；不会删除磁盘上的其他文件。此操作不可直接撤销，请确认该路径确实不需要恢复。',
})
Object.assign(filesyncAdminUiBase['ja-JP'], {
  confirmMissingDelete: '欠落を確認して記録を削除',
  confirmMissingDeleteMessage: '対応するファイル記録をゴミ箱へ移し、削除を記録します。他のディスク上のファイルは削除しません。パスを復元する必要がないことを確認してください。',
})
Object.assign(filesyncAdminUiBase['en-US'], {
  confirmMissingDelete: 'Confirm missing and delete record',
  confirmMissingDeleteMessage: 'Move the matching file record to trash and record the confirmed deletion. No other disk files will be deleted. Confirm that this path does not need to be restored.',
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
    results: '新增 {created} · 更新 {updated} · 移动 {moved} · 删除 {deleted} · 跳过 {skipped} · 冲突 {conflicts} · 失败 {failed} · 权限跳过 {permissionSkipped}',
    permissionSkipped: '有 {count} 个目录因权限不足未扫描；待核对状态会保留。',
    previewResults: '只读预览：扫描 {scanned} 项 · 计划新增 {created} · 更新 {updated} · 缺失 {deleted} · 冲突 {conflicts}（未写入文件库）',
    rootRecoveryBlocked: '工作区路径已变化或目录缺失，且仍有文件内容或旧记录；为保护数据没有自动重绑。请先确认并恢复原目录。',
    bindingRootUnavailable: '绑定无法解析到有效工作区目录，系统未修改数据。请检查工作区配置后重试。',
    scanIncomplete: '扫描范围不可用或不完整；未应用本次扫描结果。请检查绑定目录是否存在且可访问。',
    scanPermissionDenied: '绑定范围内有目录或文件不可访问；本次扫描结果未应用。请检查目录读取/遍历权限。',
    scanManifestUnavailable: '无法写入临时扫描清单；本次扫描结果未应用。请检查临时目录空间和权限。',
    scanManifestBudgetExceeded: '本次扫描清单超过空间预算；扫描结果未应用。已跳过不属于文件库的工作区和运行时目录，请确认文件库范围及磁盘空间。',
    scanEmptyWithRecords: '文件库扫描范围为空，但仍有对应旧记录；为保护数据，本次结果未应用。请确认绑定目录或恢复原文件。',
    scanUnsupportedSymlink: '绑定范围包含不支持的符号链接；无法证明扫描完整，因此没有应用本次结果。',
    bindingChanged: '扫描期间绑定目录发生变化；本次结果未应用，请刷新状态后重新核对。',
    projectionFailed: '部分文件未能写入文件库',
    projectionReason: {
      invalid_or_unsupported_path: '路径无效或不属于文件库范围',
      file_unavailable: '文件不可访问或已变化',
      file_filesystem_error: '读取文件系统状态失败',
      folder_unavailable: '目录不可访问',
      folder_filesystem_error: '读取目录状态失败',
      folder_outside_file_library_scope: '目录不属于文件库范围',
      quota_exceeded: '存储空间不足',
      projection_root_unavailable: '投影根目录不可用',
    },
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
    results: '新規 {created} · 更新 {updated} · 移動 {moved} · 削除 {deleted} · スキップ {skipped} · 競合 {conflicts} · 失敗 {failed} · 権限でスキップ {permissionSkipped}',
    permissionSkipped: '権限不足で {count} 個のディレクトリをスキャンできませんでした。未照合状態を維持します。',
    previewResults: '読み取り専用プレビュー：{scanned} 件 · 新規予定 {created} · 更新予定 {updated} · 欠損 {deleted} · 競合 {conflicts}（ライブラリ未変更）',
    rootRecoveryBlocked: 'ワークスペースのパスが変わったかディレクトリがなく、既存データがあるため自動再バインドしませんでした。元のディレクトリを確認・復元してください。',
    bindingRootUnavailable: '有効なワークスペースディレクトリを解決できませんでした。データは変更されていません。設定を確認してください。',
    scanIncomplete: 'スキャン範囲が利用できないか不完全です。結果は適用されていません。バインド先を確認してください。',
    scanPermissionDenied: 'バインド範囲内のディレクトリまたはファイルにアクセスできません。読み取り権限を確認してください。',
    scanManifestUnavailable: '一時スキャンマニフェストを書き込めません。空き容量と権限を確認してください。',
    scanManifestBudgetExceeded: 'スキャン清单が上限を超えました。対象範囲とディスク容量を確認してください。',
    scanEmptyWithRecords: 'スキャン範囲は空ですが既存レコードがあります。データ保護のため適用しません。元のディレクトリを確認してください。',
    scanUnsupportedSymlink: '範囲内に未対応のシンボリックリンクがあるため、結果を適用しませんでした。',
    bindingChanged: 'スキャン中にバインド先が変更されました。結果は適用されていません。状態を更新して再確認してください。',
    projectionFailed: '一部のファイルをライブラリに反映できませんでした',
    projectionReason: {
      invalid_or_unsupported_path: '無効または対象外のパス', file_unavailable: 'ファイルにアクセスできないか変更済み',
      file_filesystem_error: 'ファイルシステムの読み取り失敗', folder_unavailable: 'ディレクトリにアクセスできない',
      folder_filesystem_error: 'ディレクトリ状態の読み取り失敗', folder_outside_file_library_scope: '対象外のディレクトリ',
      quota_exceeded: '容量不足', projection_root_unavailable: '反映先ルートが利用不可',
    },
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
    results: 'Created {created} · Updated {updated} · Moved {moved} · Deleted {deleted} · Skipped {skipped} · Conflicts {conflicts} · Failed {failed} · Permission skipped {permissionSkipped}',
    permissionSkipped: '{count} directories could not be scanned due to permissions. Reconciliation remains pending.',
    previewResults: 'Read-only preview: scanned {scanned} · planned create {created} · update {updated} · missing {deleted} · conflicts {conflicts} (library unchanged)',
    rootRecoveryBlocked: 'The workspace path changed or the directory is missing, and files or old records remain. It was not rebound to protect data; verify or restore the original directory first.',
    bindingRootUnavailable: 'The binding cannot resolve to a valid workspace directory. No data was changed; check the workspace configuration.',
    scanIncomplete: 'The scan root is unavailable or incomplete; no scan results were applied. Check that the bound directory exists and is accessible.',
    scanPermissionDenied: 'A directory or file in the binding scope is not readable; no scan results were applied. Check read and traversal permissions.',
    scanManifestUnavailable: 'The temporary scan manifest could not be written; check temporary storage space and permissions.',
    scanManifestBudgetExceeded: 'The scan manifest exceeded its budget; results were not applied. Check the file-library scope and available disk space.',
    scanEmptyWithRecords: 'The scanned file-library scope is empty but matching records remain. Results were not applied; verify or restore the original directory.',
    scanUnsupportedSymlink: 'The binding contains an unsupported symbolic link, so completeness cannot be proven and results were not applied.',
    bindingChanged: 'The binding changed during the scan; results were not applied. Refresh status before retrying.',
    projectionFailed: 'Some files could not be applied to the library',
    projectionReason: {
      invalid_or_unsupported_path: 'Invalid or out-of-scope path', file_unavailable: 'File inaccessible or changed',
      file_filesystem_error: 'File-system read failed', folder_unavailable: 'Directory inaccessible',
      folder_filesystem_error: 'Directory-state read failed', folder_outside_file_library_scope: 'Directory outside library scope',
      quota_exceeded: 'Storage quota exceeded', projection_root_unavailable: 'Projection root unavailable',
    },
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
