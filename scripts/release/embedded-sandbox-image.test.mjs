import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const dockerfilePath = new URL('../../Dockerfile.sandbox-bundle', import.meta.url)

test('候选 app 镜像只从既有 app 追加只读 bundle 文件层', async () => {
  const dockerfile = await readFile(dockerfilePath, 'utf8')
  assert.match(dockerfile, /^ARG APP_IMAGE\s+FROM \$\{APP_IMAGE\}/m)
  assert.match(dockerfile, /COPY --chmod=0444 release\/embedded-bundle\/runtime-images\.tar \/opt\/gugu\/sandbox-bundle\/runtime-images\.tar/)
  assert.match(dockerfile, /COPY --chmod=0444 release\/embedded-bundle\/manifest\.json \/opt\/gugu\/sandbox-bundle\/manifest\.json/)
  assert.doesNotMatch(dockerfile, /^RUN\b|^ENV\b|^ENTRYPOINT\b|^CMD\b|^LABEL\b|^USER\b|^WORKDIR\b|^EXPOSE\b/m)
})
