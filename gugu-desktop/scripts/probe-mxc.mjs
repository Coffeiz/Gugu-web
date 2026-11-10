// 只探测能力；不修改系统 ACL、不创建容器，不把本机路径写入报告。
import { getPlatformSupport, probe } from '@microsoft/mxc-sdk/v1'

const support = getPlatformSupport()
const request = { containment: { type: 'process' }, command: 'cmd.exe /d /c exit 0', timeoutMs: 5000 }
const detail = process.platform === 'win32' ? probe(request) : null
console.log(JSON.stringify({
  supported: support.isSupported,
  methods: support.availableMethods,
  tier: detail?.tier ?? null,
  needsHostPreparation: detail?.needsDaclAugmentation ?? false,
  warningCount: (support.isolationWarnings?.length ?? 0) + (detail?.warnings?.length ?? 0),
  compatible: detail ? !detail.error : null,
}, null, 2))
