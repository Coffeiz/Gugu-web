import { describe, expect, it } from 'vitest'
import { supportedStoragePatch } from '@/views/Admin/Config/utils/storageConfigPatch'

describe('2.0 管理配置存储补丁', () => {
  it('仅提交 Local 配置，旧 OSS 配置不阻断其他 Admin 设置保存', () => {
    expect(supportedStoragePatch({ backend: 'oss', oss_access_key_secret: '' })).toEqual({})
    expect(supportedStoragePatch({ backend: 'local', local_path: '/data/users' })).toEqual({
      storage: { backend: 'local', local_path: '/data/users' },
    })
  })
})
