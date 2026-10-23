import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR, fetchScript, runsDir, todayInShanghai, weekdayOf } from "./config.ts";
import { log } from "./log.ts";
import { generateSection } from "./model.ts";
import type { Store } from "./store.ts";
import { translateSection, type Translator } from "./translate.ts";
import type { DigestDay, DigestSection, ProgressEvent, SourceKey, SourceStatus } from "./types.ts";
import { SOURCE_FILES, SOURCE_KEYS, SOURCE_TITLES } from "./types.ts";

/** Twitter 分块上限。超过会触发限流，原项目实测 12KB 可用。 */
const TWITTER_CHUNK_BYTES = 12_000;

/** 抓取脚本的超时。dokobot 抓 X 可到 120s，四个源串行，给足余量。 */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

export interface GenerateDayOptions {
  date: string;
  store: Store;
  translator: Translator;
  onProgress?: (event: ProgressEvent) => void;
  /** 只抓指定来源；省略抓全部四个。 */
  sources?: SourceKey[];
}

export interface GenerateDayResult {
  ok: boolean;
  day?: DigestDay;
  error?: string;
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
  const logger = log();
  const bin = fetchScript();
  // fetch.sh 的 --sources 用抓取脚本自己的名字（gh/hn/zhihu/twitter），与内部 key 不同
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

interface Chunk {
  key: SourceKey;
  path: string;
}

/** 读取某天的抓取产物，切分成模型调用用的块。 */
async function prepareChunks(date: string): Promise<Chunk[]> {
  const dir = runsDir(date);
  await mkdir(dir, { recursive: true });
  const chunks: Chunk[] = [];

  for (const key of SOURCE_KEYS) {
    const source = join(dir, SOURCE_FILES[key]);
    let content: string;
    try {
      content = await readFile(source, "utf8");
    } catch {
      continue; // 该来源没抓到
    }
    if (content.trim() === "") continue;

    if (key === "twitter") {
      // 滤掉图片/统计噪音并限长：原项目实测裸文本会触发限流
      const cleaned = content
        .split("\n")
        .filter((line) => !/\.(png|jpg|jpeg|webp|gif)([?/ ]|$)/i.test(line))
        .filter((line) => !/(abs\.twimg|\/analytics$|amplify_video)/i.test(line))
        .join("\n")
        .slice(0, TWITTER_CHUNK_BYTES);
      const path = join(dir, "_twitter.txt");
      await writeFile(path, cleaned, "utf8");
      chunks.push({ key, path });
      continue;
    }

    if (key === "zhihu") {
      // 知乎拆两块：单块 20 条会让模型漏条，原项目实测拆成 1-10 / 11-20 更稳
      const lines = content.split("\n");
      const first = join(dir, "_zhihu1.txt");
      const second = join(dir, "_zhihu2.txt");
      await writeFile(first, lines.slice(2, 12).join("\n"), "utf8");
      await writeFile(second, lines.slice(12).join("\n"), "utf8");
      chunks.push({ key, path: first }, { key, path: second });
      continue;
    }

    chunks.push({ key, path: source });
  }

  return chunks;
}

/** 把同一个 key 的多块结果拼成一个章节。 */
function mergeSections(key: SourceKey, sections: DigestSection[]): DigestSection | null {
  if (sections.length === 0) return null;
  if (sections.length === 1) return sections[0]!;

  const allItems = sections.flatMap((section) => (section.kind === "items" ? section.items : []));
  if (allItems.length === 0) return sections[0]!;
  return { key, title: SOURCE_TITLES[key], kind: "items", items: allItems };
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
  const logger = log();
  const { date, store, translator, onProgress } = options;
  const sources = options.sources ?? [...SOURCE_KEYS];

  const startedAt = Date.now();
  logger.info("generate started", { date, sources });

  // 1) 抓取
  emit(onProgress, "fetch", "抓取四个来源…", { ratio: 0.05 });
  await rm(runsDir(date), { recursive: true, force: true });
  const fetched = await runFetch(date, sources);
  if (!fetched.ok) {
    logger.error("fetch failed", { date, error: fetched.error });
    emit(onProgress, "error", `抓取失败：${fetched.error ?? "未知"}`);
    return { ok: false, error: fetched.error ?? "抓取失败" };
  }

  // 2) 分块
  const chunks = await prepareChunks(date);
  if (chunks.length === 0) {
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
      const previous = statuses[chunk.key];
      const count =
        result.section.kind === "items"
          ? result.section.items.length
          : result.section.categories.reduce((sum, c) => sum + c.items.length, 0);
      statuses[chunk.key] = { ok: true, count: (previous?.count ?? 0) + count };
    } else {
      statuses[chunk.key] = { ok: false, count: 0, error: result.error ?? "生成失败" };
      logger.warn("chunk failed", { source: chunk.key, error: result.error });
    }
  }

  // 4) 合并 + 机翻
  const sections: DigestSection[] = [];
  for (const key of SOURCE_KEYS) {
    const parts = produced.get(key);
    if (parts === undefined || parts.length === 0) continue;

    emit(onProgress, "translate", `翻译「${SOURCE_TITLES[key]}」…`, { source: key });
    const merged = mergeSections(key, parts);
    if (merged === null) continue;

    try {
      const translated = await translateSection(merged, { translator });
      sections.push(translated);
    } catch (error) {
      // 翻译整体异常不该让章节丢失：保留英文原文
      logger.error("translate failed", { source: key, error: String(error) });
      sections.push(merged);
    }
  }

  if (sections.length === 0) {
    logger.error("all sections failed", { date });
    emit(onProgress, "error", "所有章节都生成失败");
    return { ok: false, error: "所有章节都生成失败" };
  }

  // 没生成成功的来源补一条失败状态，页面据此显示 ⚠️
  for (const key of sources) {
    if (statuses[key] === undefined) {
      statuses[key] = { ok: false, count: 0, error: "无数据或生成失败" };
    }
  }

  // 5) 落盘
  emit(onProgress, "write", "写入数据目录…", { ratio: 0.9 });
  const day: DigestDay = {
    date,
    weekday: weekdayOf(date),
    generatedAt: new Date().toISOString(),
    model: model === "" ? "unknown" : model,
    sources: statuses,
    sections,
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

  return { ok: true, day };
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
