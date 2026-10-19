import { expect, type Page, type Locator } from '@playwright/test'

export async function dragOnto(page: Page, source: Locator, target: Locator, edgeOffset?: { x: number; y: number }) {
  // raw page.mouse.* 不像 locator.click() 那样会自动把元素滚入视口——测试账号的个人文件目录
  // 随着长期跑 e2e 会积累很多历史文件夹/文件，新建的卡片经常落在折叠区以下，不显式滚动的话
  // boundingBox 拿到的是页面坐标，但那块区域可能根本不在当前视口内，鼠标移过去等于移到空白处。
  await source.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('drag source/target 没有可见的 bounding box')
  const startX = from.x + from.width / 2
  const startY = from.y + from.height / 2
  const endX = edgeOffset ? to.x + edgeOffset.x : to.x + to.width / 2
  const endY = edgeOffset ? to.y + edgeOffset.y : to.y + to.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // 先走几步小位移越过 5px 抓取阈值，再移向落点——太快/太少步数有时不会触发 Runtime 的拖拽 session。
  await page.mouse.move(startX + 20, startY + 20, { steps: 5 })
  await page.mouse.move(endX, endY, { steps: 15 })
  // 确认 Runtime 已创建跟手代理，再释放指针；之后等待代理消失才能证明视觉事务收尾，
  // 避免仅检查“当前没有代理”时在 landing 尚未开始前提前通过。
  await expect(page.locator('[data-runtime-proxy-content="true"]').first()).toBeAttached({ timeout: 5000 })
  await page.mouse.up()
  await page.mouse.move(0, 0)
}
