# Ops：SearXNG 可用引擎排查报告

> 排查日期：2026-08-06
> 排查环境：devserver（192.168.110.51）→ SearXNG 实例（`http://192.168.110.50:8888`）
> 排查对象：`web_search`/`image_search` 工具依赖的自建 SearXNG（配置见 `backend/config.override.json` 的 `search.searxng_engines`）
> 排查目的：定位 `web_search` 一直返回 0 条结果的根因，摸清当前实例哪些引擎真正可用

---

## 现象

- 请求能正常连通（HTTP 200），但 `results` 恒为空。
- 报错里出现的"超时引擎"因请求不同而不同（如 `quark`、`sogou`），容易误以为是网络抖动。

## 排查过程

1. 直接用 curl 复现 `web_search` 实际发出的请求（`engines=sogou,quark,360search`），确认能连通但 0 结果，`unresponsive_engines` 显示 `quark`/`sogou` 均为 `Suspended: CAPTCHA`。
2. 查 `/config` 接口确认引擎注册状态：`sogou`/`quark`/`360search` 三个在 `settings.yml` 里都是 `enabled: false`。
3. 单独测试三个引擎：
   - `360search`：`enabled=false` 且不可通过 `engines=` 参数强制启用，请求根本不会真正发出，`unresponsive_engines` 里也不会出现它。
   - `quark`/`sogou`：`enabled=false` 但显式指定 `engines=` 时仍会被拉起来跑，结果被夸克/搜狗的反爬拦截返回 CAPTCHA，触发 SearXNG 的自动熔断（`/stats/errors` 显示 CAPTCHA 类异常自带 `suspended_time=3600`，即 1 小时冷却，冷却期内直接跳过不再真的发请求）。
4. 排查图片搜索为什么"看起来正常"：`searxng_image_engines` 为空时回退用 `searxng_engines`（文本引擎名），但图片分类下的引擎名是 `"sogou images"`/`"quark images"` 等，跟配置里的 `sogou`/`quark`/`360search`（general 分类的名字）对不上。SearXNG 的 `engines=` 参数按引擎名精确匹配、且会强制拉起（不受请求的 `categories` 限制），所以：
   - `quark`/`sogou`（general）被强行拉起但返回的是网页链接、没有 `img_src`，被 `agent/tools/search.py` 的过滤逻辑丢弃，对图片结果零贡献，还额外撞了一次 CAPTCHA。
   - `360search` 因 `enabled=false` 依然不会真的执行。
   - 图片搜索实际能出结果，全靠 SearXNG 在 `images` 分类下**默认启用**的那批引擎（`bing images`/`google images`/`pexels`/`unsplash`/`pinterest`/`flickr`/`openverse` 等），这批国际图片站点/CDN 目前没被这台服务器的出口 IP 拉黑或墙掉，跟配置的 `searxng_image_engines` 无关（配置其实形同虚设）。
5. 排查"不指定 engines 时只搜出 1 条"：`general` 分类下默认启用的引擎是 `wikipedia`/`currency`/`wikidata`/`duckduckgo`/`google`/`lingva`/`startpage`/`dictzone`/`mymemory translated`/`brave` 共 10 个，但其中只有 `duckduckgo`/`google`/`startpage`/`brave` 是真正的网页搜索：
   - `duckduckgo`/`startpage`/`brave`：被标记 `Suspended`（CAPTCHA / 请求过多）。
   - `google`：**不报错但也是 0 结果**——大概率是软拦截（返回的页面结构对不上 SearXNG 解析规则），比显式的 CAPTCHA 拦截更隐蔽。
   - 其余 6 个是维基百科/货币换算/翻译词典等专用小工具引擎，非通用查询本来就搜不出东西。
   - 因此默认配置下"只搜出 1 条"多半是蒙对了某个专用小工具（如维基词条命中），并非真实网页搜索结果。
6. 网页 UI（SearXNG 偏好设置页）里勾选的"开启的搜索引擎"**不会同步到后端调用**：网页偏好存在浏览器 cookie 里，后端调用的是不带 cookie 的裸 API 请求，只认 `settings.yml` 的静态 `enabled` 状态 + 请求显式带的 `engines=` 参数。要让某个引擎对后端生效，必须去 `settings.yml` 改 `disabled`，不是在网页上点开关。
7. 用脚本批量测试了 `settings.yml` 里列出的全部 web/通用分类引擎（`weather today` 查询，逐个用 `engines=<name>` 单测），得到完整可用性清单（见下）。

## 结论：可用引擎清单

**✅ 有真实结果**（按结果数降序）：

| 引擎 | 结果数 |
|---|---|
| `reloado` | 57 |
| `mwmbl` | 52 |
| `gabanza` | 30 |
| `resulthunter` | 20 |
| `duckduckgo web` | 10 |
| `fynd` | 10 |
| `gmx` | 10 |
| `privacywall` | 10 |
| `yacy` | 10 |
| `yandex` | 10 |
| `searchch` | 10 |
| `abcnyheter` | 10 |
| `zapmeta` | 9 |
| `boardreader` | 9 |
| `dogpile` | 8 |
| `infospace` | 8 |
| `searchtoday` | 8 |
| `fireball` | 5 |
| `bpb` | 3 |

**❌ 不可用**（超时 / CAPTCHA / access denied / 静默 0 结果）：
`bing`、`brave`、`duckduckgo`（注意跟能用的 `duckduckgo web` 是两个不同引擎条目）、`presearch`、`qwant`、`startpage`、`yahoo`、`seznam`、`naver`、`encyclosearch`、`fastbot`、`tusksearch`、`yep`、`wikimini`、`baidu`、`quark`、`sogou`、`360search`、`google`、`mojeek`、`ayo`、`crowdview`、`vuhuv`、`wikipedia`（后三个及 `tagesschau` 本身也非通用网页搜索）

## 后续建议

- `backend/config.override.json` 的 `search.searxng_engines` 从 `sogou,quark,360search` 改为可用清单中的一组组合，例如：
  ```
  yandex,duckduckgo web,mwmbl,gabanza,reloado,searchch,privacywall,gmx,zapmeta
  ```
- `search.searxng_image_engines` 目前留空、回退用文本引擎名（对图片分类无效），建议显式配一批实测有效的图片引擎（`bing images`/`google images`/`pexels`/`unsplash`/`pinterest`/`flickr`/`openverse` 等）。
- `agent/tools/search.py` 顶部注释里"国内服务器只有 sogou/quark/360search 可达"的假设已经过时，需要连带更新，避免以后排查时被误导。
- quark/sogou/baidu 的 CAPTCHA 熔断有自动冷却（约 1 小时），冷却过后可以再测一次看是否恢复，但即使恢复也建议只作为兜底、不作为主力引擎（容易再次被高频请求触发风控）。
