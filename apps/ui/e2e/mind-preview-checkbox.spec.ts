import { expect, test } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] } })

test('笔记预览乐观勾选保留节点，底色正反向过渡均有中间帧', async ({ page }) => {
  // 独立 Vue 夹具使用真实渲染器、directive 与全局样式，无需账号或业务数据。
  await page.goto('/e2e/fixtures/mind-preview-checkbox.html')
  const checkbox = page.getByRole('checkbox')
  await expect(checkbox).toBeVisible()
  const original = await checkbox.elementHandle()
  await expect(checkbox).not.toBeChecked()

  for (const checked of [true, false]) {
    await checkbox.evaluate(el => {
      const sampled = el as HTMLInputElement & { opacitySamples: number[] }
      sampled.opacitySamples = []
      sampled.addEventListener('click', () => {
        const started = performance.now()
        function sample() {
          sampled.opacitySamples.push(Number(getComputedStyle(sampled, '::before').opacity))
          if (performance.now() - started < 300) requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }, { once: true, capture: true })
    })
    await checkbox.click()
    await expect(checkbox).toBeChecked({ checked })
    expect(await original!.evaluate(el => el === document.querySelector('input'))).toBe(true)
    await expect.poll(() => checkbox.evaluate(el => {
      const samples = (el as HTMLInputElement & { opacitySamples: number[] }).opacitySamples
      return samples.some(opacity => opacity > 0 && opacity < 1)
    })).toBe(true)
    await expect.poll(() => checkbox.evaluate(el => Number(getComputedStyle(el, '::before').opacity)))
      .toBe(checked ? 1 : 0)
  }
})
