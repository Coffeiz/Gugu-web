import { defineConfig } from 'vitest/config'
import { testSuites } from './scripts/test-suites.mjs'

export default defineConfig({
  test: {
    environment: 'node',
    include: testSuites(process.env.GUGU_CORE_TEST_SUITE ?? 'default').map(
      (item) => item.file,
    ),
    testTimeout: 30_000,
    fileParallelism: false,
  },
})
