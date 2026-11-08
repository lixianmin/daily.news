import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fetchTwitterRaw } from "./chrome/twitter.ts";
import { DATA_DIR, fetchScript, runsDir, todayInShanghai, weekdayOf } from "./config.ts";
import { enrichSection, buildMetaIndexes, limitSectionItems } from "./enrich.ts";
import { logger } from "./logo.ts";
import { generateSection } from "./model.ts";
import type { Store } from "./store.ts";
import { translateSection, type Translator } from "./translate.ts";
import { buildTwitterSectionFromRuns } from "./twitter.ts";
import { buildZhihuSectionFromRuns } from "./zhihu.ts";
import type { DigestDay, DigestSection, ProgressEvent, SourceKey, SourceStatus } from "./types.ts";
import { SOURCE_FILES, SOURCE_KEYS, SOURCE_TITLES } from "./types.ts";

/**
 * 不走模型、正文直接翻译的来源。
 *
 * 模型只给推文分主题（Twitter），知乎连模型都不碰——正文是原文的直译。
 */
const DIRECT_SOURCES: readonly SourceKey[] = ["twitter", "zhihu"];

/** 抓取脚本的超时。dokobot 抓 X 可到 120s，四个源串行，给足余量。 */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

export interface GenerateDayOptions {
  date: string;
  store: Store;
  translator: Translator;
  onProgress?: (event: ProgressEvent) => void;
  /** 只抓指定来源；省略抓全部四个。 */
  sources?: SourceKey[];
  /**
   * 只重试失败的来源，合并进已有成品。
   *
   * 失败重试用：整天的其它来源已经生成成功了，重跑一遍既浪费额度又
   * 可能把好的内容换成新的（比如热榜已经变了）。所以只补失败的来源，
   * 成功的章节原样保留。
   */
  retryFailedSources?: SourceKey[];
}

export interface GenerateDayResult {
  ok: boolean;
  day?: DigestDay;
  error?: string;
  /** 本轮失败的来源。用于决定要不要重试、重试哪些。 */
  failedSources?: SourceKey[];
}

function emit(
  onProgress: ((event: ProgressEvent) => void) | undefined,
  stage: ProgressEvent["stage"],
  message: string,
  extra: Partial<ProgressEvent> = {},
): void {
  onProgress?.({ stage, message, at: new Date().toISOString(), ...extra });
}

/** 跑抓取脚本。返回是否成功，不抛。 */
async function runFetch(date: string, sources: SourceKey[]): Promise<{ ok: boolean; error?: string }> {
  const bin = fetchScript();
  // fetch.sh 的 --sources 用抓取脚本自己的名字（gh/hn/zhihu），与内部 key 不同
  const scriptNames = sources.map(scriptName).join(",");

  logger.info("fetch started", { date, sources: scriptNames });

  return await new Promise((resolve) => {
    const proc = spawn("/bin/bash", [bin, "--date", date, "--sources", scriptNames], {
      env: { ...process.env, DAILY_NEWS_DATA_DIR: DATA_DIR },
      timeout: FETCH_TIMEOUT_MS,
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      resolve({ ok: false, error: String(error) });
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: stderr.trim().split("\n").slice(-3).join(" | ") || `exit=${code}` });
      }
    });
  });
}

/** 内部 key → fetch.sh 的来源名。 */
function scriptName(key: SourceKey): string {
  switch (key) {
    case "github":
      return "gh";
    case "hackernews":
      return "hn";
    default:
      return key;
  }
}

/**
 * Twitter 来源：走 pi-chrome（用户真实 Chrome 的已登录会话）。
 *
 * 失败不抛——Twitter 只是四个来源之一，挂了其它三个照常出稿，
 * 页面上该来源标 ⚠️。返回错误原因（成功时 undefined）。
 */
async function fetchTwitterSource(date: string): Promise<string | undefined> {
  const result = await fetchTwitterRaw({ dataDir: DATA_DIR, date });
  if (!result.ok) {
    logger.warn("twitter fetch failed", { date, error: result.error });
    return result.error ?? "抓取失败";
  }
  logger.info("twitter fetched", { date, count: result.count, role: result.role ?? null });
  return undefined;
}

/**
 * 本轮实际负责的来源。
 *
 * 全量生成时是全部四个；补生成（`retryFailedSources`）时只有要补的那几个。
 *
 * 抓取、补失败状态、算失败来源都按这个集合来。补生成时若还按“四个来源”算，
 * 没补的那三个会被标成「无数据或生成失败」——页面上凭空多出三个 ⚠️，
 * 而且失败来源集合也会一直把它们算进去，重试链停不下来。
 */
export function attemptedSources(sources: SourceKey[], retrying?: SourceKey[]): SourceKey[] {
  return retrying ?? sources;
}

/**
 * 给本轮负责、但没产出章节的来源补一条失败状态。
 *
 * 页面按 `sources[key].ok === false` 显示 ⚠️，所以漏掉的来源要显式标出来。
 * 但只标本轮负责的——补生成时没轮到的来源，成品里本来就该保留原状态。
 */
export function fillMissingStatuses(
  statuses: Partial<Record<SourceKey, SourceStatus>>,
  attempted: SourceKey[],
): Partial<Record<SourceKey, SourceStatus>> {
  const result = { ...statuses };
  for (const key of attempted) {
    if (result[key] === undefined) {
      result[key] = { ok: false, count: 0, error: "无数据或生成失败" };
    }
  }
  return result;
}

interface Chunk {
  key: SourceKey;
  path: string;
}

/**
 * 读取某天的抓取产物，切分成模型调用用的块。
 *
 * `only` 给了就只切这些来源（补生成模式）。
 *
 * 只有走模型的来源（GitHub / Hacker News）才需要分块。Twitter 与知乎的正文
 * 是原文的直译，不经模型。
 */
async function prepareChunks(date: string, only?: SourceKey[]): Promise<Chunk[]> {
  const dir = runsDir(date);
  await mkdir(dir, { recursive: true });
  const chunks: Chunk[] = [];

  const wanted = only ?? [...SOURCE_KEYS];
  for (const key of wanted) {
    if (DIRECT_SOURCES.includes(key)) {
      continue;
    }
    const source = join(dir, SOURCE_FILES[key]);
    let content: string;
    try {
      content = await readFile(source, "utf8");
    } catch {
      continue; // 该来源没抓到
    }
    if (content.trim() === "") {
      continue;
    }

    chunks.push({ key, path: source });
  }

  return chunks;
}

/** 把同一个 key 的多块结果拼成一个章节。 */
function mergeSections(key: SourceKey, sections: DigestSection[]): DigestSection | null {
  if (sections.length === 0) {
    return null;
  }
  if (sections.length === 1) {
    return sections[0]!;
  }

  const allItems = sections.flatMap((section) => (section.kind === "items" ? section.items : []));
  if (allItems.length === 0) {
    return sections[0]!;
  }
  return { key, title: SOURCE_TITLES[key], kind: "items", items: allItems };
}

/**
 * 合并一个来源的多块状态。
 *
 * 同一来源可能拆成多块（知乎是 1-10 / 11-20 两块）。某块失败**不能**把
 * 整来源标成失败——另一块可能已经成功了，而且它的数据是好的。
 *
 * 曾经的 bug：失败分支直接 `statuses[key] = { ok: false, count: 0 }`，
 * 覆盖了第一块的 `{ ok: true, count: 5 }`。结果明明有 5 条数据，
 * 页面却显示「知乎失败」，还触发一次没必要的补生成。
 *
 * 三种状态：
 *   - 没有成功块 → ok: false（整来源失败）
 *   - 有成功块、这次也成功 → ok: true，count 累加
 *   - 有成功块、这次失败 → ok: true（部分失败），但记下原因
 */
export function mergeSourceStatus(
  previous: SourceStatus | undefined,
  outcome: { ok: boolean; count: number; error?: string },
): SourceStatus {
  if (outcome.ok) {
    return { ok: true, count: (previous?.count ?? 0) + outcome.count };
  }
  // 这次失败
  if (previous?.ok !== true) {
    // 一个成功块都没有 → 整来源失败
    return { ok: false, count: previous?.count ?? 0, error: outcome.error ?? "生成失败" };
  }
  // 有成功块 → 部分失败，保留成功状态与已有条数
  return { ok: true, count: previous.count, error: `部分块失败：${outcome.error ?? "生成失败"}` };
}

/** 一个章节里有多少条（Twitter 是要点数，其余是条目数）。 */
function countSectionItems(section: DigestSection): number {
  if (section.kind === "items") {
    return section.items.length;
  }
  return section.categories.reduce((sum, category) => sum + category.items.length, 0);
}

/** 一个来源有几条数据，用于「抓到了但没生成成功」时的状态描述。 */
function countSourceLines(content: string): number {
  return content.split("\n").filter((line) => line.startsWith("- ")).length;
}

/**
 * 跑一次完整生成：抓取 → 分块 → 模型 → 机翻 → 落盘。
 *
 * 任一来源失败不阻断其它来源：能生成几块就写几块，失败的章节不写进成品
 * （页面按 `sources[key].ok === false` 显示 ⚠️）。
 */
export async function generateDay(options: GenerateDayOptions): Promise<GenerateDayResult> {
  const { date, store, translator, onProgress } = options;
  const sources = options.sources ?? [...SOURCE_KEYS];

  const startedAt = Date.now();
  // 补生成模式：只重试失败的那些来源，已成功的章节原样保留
  const retrying = options.retryFailedSources;
  // 本轮实际负责的来源。补生成时只有要补的那几个。
  const attempted = attemptedSources(sources, retrying);
  logger.info("generate started", { date, sources, retrying: retrying ?? null });

  // 1) 抓取
  emit(onProgress, "fetch", retrying === undefined ? "抓取四个来源…" : `补抓 ${retrying.length} 个失败来源…`, { ratio: 0.05 });
  if (retrying === undefined) {
    // 全量生成：清掉上次的抓取产物，避免读到旧的
    await rm(runsDir(date), { recursive: true, force: true });
  }

  // Twitter 走 Chrome 扩展（真实浏览器的登录态），其余三个走 fetch.sh。
  // 顺序：先删旧产物再抓，否则 twitter_raw.txt 会被上次的残留顶掉。
  const twitterError = attempted.includes("twitter") ? await fetchTwitterSource(date) : undefined;

  const shellSources = attempted.filter((key) => key !== "twitter");
  const fetched = shellSources.length === 0 ? { ok: true } : await runFetch(date, shellSources);
  if (!fetched.ok) {
    logger.error("fetch failed", { date, error: fetched.error });
    emit(onProgress, "error", `抓取失败：${fetched.error ?? "未知"}`);
    return { ok: false, error: fetched.error ?? "抓取失败" };
  }

  // 2) 分块（只有走模型的来源需要）
  const chunks = await prepareChunks(date, retrying);
  const directSources = attempted.filter((key) => DIRECT_SOURCES.includes(key));
  if (chunks.length === 0 && directSources.length === 0) {
    logger.error("no chunks", { date });
    emit(onProgress, "error", "四个来源都没抓到数据");
    return { ok: false, error: "四个来源都没抓到数据" };
  }
  logger.info("chunks prepared", { date, chunks: chunks.map((c) => c.key) });

  // 3) 逐块生成
  const statuses: Partial<Record<SourceKey, SourceStatus>> = {};
  const produced = new Map<SourceKey, DigestSection[]>();
  let model = "";

  for (const [index, chunk] of chunks.entries()) {
    const label = SOURCE_TITLES[chunk.key];
    emit(onProgress, "generate", `生成「${label}」（${index + 1}/${chunks.length}）`, {
      ratio: 0.1 + (index / chunks.length) * 0.6,
      source: chunk.key,
    });

    let result = await generateSection({ key: chunk.key, chunkPath: chunk.path });

    // 「0 条有效条目」多半是模型偷懒或输出被截断，值得再要一次
    if (!result.ok && (result.error ?? "").includes("没有有效")) {
      logger.warn("retrying empty section", { source: chunk.key });
      result = await generateSection({ key: chunk.key, chunkPath: chunk.path });
    }

    if (result.ok && result.section !== undefined) {
      const list = produced.get(chunk.key) ?? [];
      list.push(result.section);
      produced.set(chunk.key, list);
      model = result.model ?? model;
      const count =
        result.section.kind === "items"
          ? result.section.items.length
          : result.section.categories.reduce((sum, c) => sum + c.items.length, 0);
      statuses[chunk.key] = mergeSourceStatus(statuses[chunk.key], { ok: true, count });
    } else {
      statuses[chunk.key] = mergeSourceStatus(statuses[chunk.key], {
        ok: false,
        count: 0,
        error: result.error ?? "生成失败",
      });
      logger.warn("chunk failed", { source: chunk.key, error: result.error });
    }
  }

  // 3.5) 直译来源：Twitter 与知乎的正文是原文的直译，不经模型
  for (const key of directSources) {
    emit(onProgress, "translate", `翻译「${SOURCE_TITLES[key]}」…`, { source: key });
    try {
      const section =
        key === "twitter"
          ? await buildTwitterSectionFromRuns({ runsDir: runsDir(date), translator })
          : await buildZhihuSectionFromRuns({ runsDir: runsDir(date), translator });
      produced.set(key, [section]);
      statuses[key] = mergeSourceStatus(statuses[key], {
        ok: true,
        count: countSectionItems(section),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("direct section failed", { source: key, error: reason });
      statuses[key] = mergeSourceStatus(statuses[key], { ok: false, count: 0, error: reason });
    }
  }

  // Twitter 抓取就失败了（没进分块阶段）：标成失败，页面上显示 ⚠️
  if (twitterError !== undefined) {
    statuses.twitter = mergeSourceStatus(statuses.twitter, { ok: false, count: 0, error: twitterError });
  }

  // 4) 合并 → 回填元信息 → 机翻
  const sections: DigestSection[] = [];
  const metaIndexes = await buildMetaIndexes(runsDir(date));

  for (const key of SOURCE_KEYS) {
    const parts = produced.get(key);
    if (parts === undefined || parts.length === 0) {
      continue;
    }

    // 先截断再回填元信息（去重 HN 摘要里的重复数字），再翻译——
    // 顺序反了的话，译出来的是带重复数字的旧文本
    const merged = mergeSections(key, parts);
    if (merged === null) {
      continue;
    }
    const limited = limitSectionItems(merged);
    const enriched = await enrichSection(limited, { runsDir: runsDir(date), date }, metaIndexes);

    // 直译来源在 3.5 已经翻完并报过进度，这里只补分类标题的繁中
    if (!DIRECT_SOURCES.includes(key)) {
      emit(onProgress, "translate", `翻译「${SOURCE_TITLES[key]}」…`, { source: key });
    }
    try {
      sections.push(await translateSection(enriched, { translator }));
    } catch (error) {
      // 翻译整体异常不该让章节丢失：保留英文原文
      logger.error("translate failed", { source: key, error: String(error) });
      sections.push(enriched);
    }
  }

  if (sections.length === 0) {
    logger.error("all sections failed", { date });
    emit(onProgress, "error", "所有章节都生成失败");
    return { ok: false, error: "所有章节都生成失败" };
  }

  // 没生成成功的来源补一条失败状态，页面据此显示 ⚠️
  // 只标本轮负责的：补生成时没轮到的来源，成品里保留原状态
  const finalStatuses = fillMissingStatuses(statuses, attempted);

  // 本轮失败的来源——决定要不要重试、重试哪些
  // 只看本轮负责的：没轮到的来源不算失败（否则重试链会一直带着它们）
  const failedSources = attempted.filter((key) => finalStatuses[key]?.ok !== true);

  // 5) 落盘
  emit(onProgress, "write", "写入数据目录…", { ratio: 0.9 });

  // 补生成模式：跟已有成品合并——成功的章节原样保留，
  // 只把这次补上的来源替换进去。整份覆盖的话，其它来源会凭空消失。
  let finalSections = sections;
  let finalSources = finalStatuses;
  if (retrying !== undefined) {
    const existing = await store.readDay(date);
    if (existing !== null) {
      const merged = new Map(existing.sections.map((sec) => [sec.key, sec]));
      for (const sec of sections) {
        merged.set(sec.key, sec);
      }
      // 按 SOURCE_KEYS 的固定顺序排，页面显示才稳定
      finalSections = SOURCE_KEYS.filter((key) => merged.has(key)).map((key) => merged.get(key)!);
      finalSources = { ...existing.sources, ...finalStatuses };
      logger.info("merged retry into existing day", {
        date,
        kept: existing.sections.length,
        replaced: sections.length,
      });
    }
  }

  const day: DigestDay = {
    date,
    weekday: weekdayOf(date),
    generatedAt: new Date().toISOString(),
    model: model === "" ? "unknown" : model,
    sources: finalSources,
    sections: finalSections,
  };

  try {
    await store.writeDay(day);
  } catch (error) {
    logger.error("write failed", { date, error: String(error) });
    emit(onProgress, "error", `写入失败：${String(error)}`);
    return { ok: false, error: String(error) };
  }

  const elapsedMs = Date.now() - startedAt;
  logger.info("generate finished", {
    date,
    sections: sections.length,
    elapsedMs,
    model: day.model,
  });
  emit(onProgress, "done", `完成：${sections.length} 个章节，用时 ${Math.round(elapsedMs / 1000)}s`, {
    ratio: 1,
  });

  return { ok: true, day, failedSources };
}

/** 排障用：某个来源原始数据里有几条。 */
export async function inspectSource(date: string, key: SourceKey): Promise<number> {
  try {
    const content = await readFile(join(runsDir(date), SOURCE_FILES[key]), "utf8");
    return countSourceLines(content);
  } catch {
    return 0;
  }
}

export { todayInShanghai };
