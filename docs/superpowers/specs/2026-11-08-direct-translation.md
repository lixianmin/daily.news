# 直接翻译展示（Twitter / 知乎）

日期：2026-11-08
范围：只改 Twitter 与知乎两个来源；GitHub / Hacker News 保持现状（仍是大模型总结 + 机翻）。

## 问题

1. **正文是总结，不是原文。** Twitter 与知乎的正文由大模型「总结」而成，再机翻成中文。读者看到的是压缩后的要点，看不到推文/问题本身说了什么。
2. **Twitter 的 @handle 链接指错地方。** 要点里的 `@xxxx` 有时指向作者主页（`x.com/<handle>`），而不是那条推文。根因是模型只给 handle，链接靠「handle → 推文直链」反查；同一作者发过多条时必然对不上，反查不到就退回主页。
3. **折叠不生效。** `.card-sum.clamp > .en` 这条 CSS 匹配不到真实 DOM（`.en` 在 `.duo` 里面），所以「More ▾」点了没反应，摘要永远全展开。

## 目标

1. 正文改为**直接翻译**：左列英文、右列繁体中文，两列都是原文的翻译，不是总结。
2. 折叠态只显示三行，点「More ▾」展开完整段落。
3. Twitter 的 `@handle` 链接指向那条推文的直链。
4. 原文内容不经大模型改写。

## 设计

### Twitter

```
twitter_raw.txt ──parseTwitterRaw──▶ RawTweet[]（带推文直链）
        │
        ├─buildTwitterChunk──▶ 分块文件 ──模型──▶ 分类归属（只分主题，不写正文）
        │
        └─逐条推文正文 ──翻译──▶ 英文 + 繁中
```

- **解析**：`parseTwitterRaw()` 从 `twitter_raw.txt` 还原每条推文（显示名、handle、相对时间、正文、推文直链）。直链取脚注区里的 `/status/` 链接——抓取时就有的原始 URL，不再靠 handle 反查。
- **归类**：模型只把推文分到 3~6 个主题，输出 `{"categories":[{"title":"...","tweetIds":[1,4]}]}`。正文一个字都不由模型写。模型调用失败时退化成单分类 `Timeline`，推文一条不丢（`assignTweets` 把没被分到分类的推文收进兜底分类）。
- **翻译**：推文正文 → 英文 + 繁中。英文原文的推文左列就是原文（不翻译），右列是繁中译文。
- **渲染**：分类下逐条推文；行首 `@handle` 链到该推文直链，旁边是相对时间；正文左英右繁，默认夹三行，点「More ▾」展开。

### 知乎

```
zhihu.md ──parseZhihu──▶ 标题 + 摘要片段 + 链接
        └─逐条（标题 + 摘要片段）──翻译──▶ 英文 + 繁中
```

- **解析**：`parseZhihu()` 从 `zhihu.md` 取问题标题、答案摘要片段、热度、链接。
- **不走模型**：知乎正文直接翻译，没有总结环节。卡片标题保持中文原题（链到问题页），正文左英右繁，夹三行可展开。

### 翻译链路

`toBilingual(texts, translator)` 一次处理一批：英文原文只翻繁中（一趟），中文/日文/韩文原文既翻英文也翻繁中（两趟）。返回与入参等长，翻不出来的位置是空串，失败的那一列退回原文。

`createTranslator()` 三级降级：

1. Google 免费端点（`sl=auto`）——逐条串行，请求间留 250ms 间隔（突发并发会被打成 429）。
2. MyMemory——不同服务商，配额更小。
3. **模型兜底**——前两级都拿不到时，把失败的那批交给 deepseek，用专门的「只许逐字翻译，不许总结/合并/删减」system prompt，一次调用翻整批（`translateWithModel`），返回条数必须与输入一致，否则整批作废。

模型的翻译 prompt 与摘要 prompt 完全分开：摘要那套允许概括，翻译这套明确禁止。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `CategoryItem` 加 `handle` / `time` |
| `src/chrome/twitter.ts` | 新增 `parseTwitterRaw()` |
| `src/zhihu.ts`（新） | `parseZhihu()` + `buildZhihuSection()` + `buildZhihuSectionFromRuns()` |
| `src/twitter.ts`（新） | `buildTwitterChunk()` / `assignTweets()` / `buildTwitterSection()` / `buildTwitterSectionFromRuns()` |
| `src/translate.ts` | `Translator` 改成批量；`toBilingual()`；`translateSection()` 一次批量翻 |
| `src/translator.ts` | 三级降级 + 请求间隔 + 模型兜底 |
| `src/model.ts` | `callChannels` 抽出通用双通道调用；`categorizeTweets()`；`translateWithModel()` |
| `src/llm.ts` | `parseTweetCategories()` / `parseTranslations()`；`parseSection` 不再管 Twitter |
| `prompts/format.md` | Twitter 章节改成「只分主题」schema |
| `src/generator.ts` | Twitter / 知乎走直译管线（`DIRECT_SOURCES`），GitHub / HN 不变 |
| `src/render.ts` | Twitter 逐条推文的渲染（handle 链到推文） |
| `src/design.ts` | 修 `.card-sum.clamp` 选择器；译文保留换行；补 Twitter 条目样式 |
| `public/app.js` | 展开按钮兼容 Twitter 条目（`.cat-item`） |

## 删掉的东西

- `src/meta.ts` 的 `extractTwitterLinks()` 与 `src/enrich.ts` 的 `enrichTwitter()`：靠 handle 反查推文直链的老路子，被解析层取代（同一作者多条推文时它本来就对不上）。
- `src/generator.ts` 里给知乎拆两块分块的逻辑：知乎不再过模型，不用拆。
- `src/translate.ts` 的 `runPool()`：翻译改成按批调用，不再需要并发池。

## 已知限制

- 推文正文截断在 600 字（沿用原限制），超长推文看不到全文。
- 知乎的摘要片段本身在抓取层截断到 180 字（`fetch.sh`），所以「完整段落」最长为那 180 字。
- 两个免费端点都挂时走模型兜底，一轮多花 1~3 分钟。

## 实测

- 2026-11-08 的真实抓取产物跑通：Twitter 9 条分 5 个主题、知乎 10 条，译文与原文逐句对应。
- 折叠在真实浏览器里验过（CDP）：`-webkit-line-clamp` 3 → none，高度 68px → 159px，再点收回。
- 模型兜底实测可用（当天 Google 与 MyMemory 都被打到限流）。
