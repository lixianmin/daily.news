import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DigestDay, DigestIndex, IndexDay, SourceKey } from "./types.ts";
import { SOURCE_KEYS } from "./types.ts";

/** 一条搜索命中。 */
export interface SearchHit {
  date: string;
  section: string;
  title: string;
  en: string;
  zh: string;
  url?: string;
}

export interface StoreOptions {
  /** 数据根目录，如 ~/Documents/daily-news。 */
  dataDir: string;
}

export interface Store {
  dataDir: string;
  writeDay(day: DigestDay): Promise<void>;
  readDay(date: string): Promise<DigestDay | null>;
  readIndex(): Promise<DigestIndex>;
  listDates(): Promise<string[]>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
}

const DEFAULT_SEARCH_LIMIT = 50;

function daysDir(dataDir: string): string {
  return join(dataDir, "days");
}

function indexPath(dataDir: string): string {
  return join(dataDir, "index.json");
}

/**
 * 原子写：先写临时文件再 rename。
 *
 * 服务可能在生成途中被 launchd 重启，直接写目标路径会留下半截 JSON，
 * 而读数方无法区分"文件损坏"与"这天没生成"。rename 在同一文件系统内是原子的。
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, path);
  } catch (error) {
    // rename 失败要清掉临时文件，别在 days/ 里留垃圾
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

function isDigestDay(value: unknown): value is DigestDay {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["date"] === "string" && Array.isArray(record["sections"]);
}

/** 数一天的条目数。Twitter 章节数分类下的要点。 */
function countItems(day: DigestDay): { total: number; counts: Partial<Record<SourceKey, number>> } {
  const counts: Partial<Record<SourceKey, number>> = {};
  let total = 0;

  for (const section of day.sections) {
    const n =
      section.kind === "items"
        ? section.items.length
        : section.categories.reduce((sum, category) => sum + category.items.length, 0);
    counts[section.key] = n;
    total += n;
  }
  return { total, counts };
}

/** 摘要用标题：优先 items 的 title，Twitter 用分类标题。最多取 6 条。 */
function pickHeadlines(day: DigestDay): string[] {
  const headlines: string[] = [];
  for (const section of day.sections) {
    if (section.kind === "items") {
      for (const item of section.items) {
        if (headlines.length >= 6) return headlines;
        headlines.push(item.title);
      }
    } else {
      for (const category of section.categories) {
        if (headlines.length >= 6) return headlines;
        headlines.push(category.title);
      }
    }
  }
  return headlines;
}

function toIndexDay(day: DigestDay): IndexDay {
  const { total, counts } = countItems(day);
  const sourcesOk = SOURCE_KEYS.filter((key) => day.sources[key]?.ok === true).length;
  return {
    date: day.date,
    weekday: day.weekday,
    generatedAt: day.generatedAt,
    total,
    counts,
    sourcesOk,
    headlines: pickHeadlines(day),
  };
}

/** 读一个 day 文件；文件损坏返回 null，不让单天坏文件拖垮整个列表。 */
async function readDayFile(dataDir: string, date: string): Promise<DigestDay | null> {
  try {
    const raw = await readFile(join(daysDir(dataDir), `${date}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isDigestDay(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 列出 days/ 下的日期（由文件名得出，倒序）。 */
async function scanDates(dataDir: string): Promise<string[]> {
  try {
    const entries = await readdir(daysDir(dataDir));
    return entries
      .filter((name) => name.endsWith(".json") && !name.includes(".tmp-"))
      .map((name) => name.slice(0, -".json".length))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 索引是**派生数据**，不是真相。
 *
 * days/ 目录才是真相。索引丢了、旧了、缺条目，都从 days/ 重建即可——
 * 这样写入方只需保证 day 文件正确，不必维护两份一致。
 */
async function rebuildIndex(dataDir: string, dates: string[]): Promise<DigestIndex> {
  const days: IndexDay[] = [];
  for (const date of dates) {
    const day = await readDayFile(dataDir, date);
    if (day !== null) days.push(toIndexDay(day));
  }
  return { updatedAt: new Date().toISOString(), days };
}

export function createStore(options: StoreOptions): Store {
  const { dataDir } = options;

  return {
    dataDir,

    async writeDay(day) {
      await mkdir(daysDir(dataDir), { recursive: true });
      await writeJsonAtomic(join(daysDir(dataDir), `${day.date}.json`), day);
      // 写完立刻重建索引：索引是派生数据，重建比增量维护少一类 bug
      const dates = await scanDates(dataDir);
      await writeJsonAtomic(indexPath(dataDir), await rebuildIndex(dataDir, dates));
    },

    async readDay(date) {
      return readDayFile(dataDir, date);
    },

    async readIndex() {
      const dates = await scanDates(dataDir);

      try {
        const raw = await readFile(indexPath(dataDir), "utf8");
        const parsed = JSON.parse(raw) as DigestIndex;
        if (!Array.isArray(parsed.days)) throw new Error("bad index shape");

        // 索引与磁盘对不上（旧索引 / 历史遗留文件）时重建，别让列表页显示残缺
        const indexed = parsed.days.map((entry) => entry.date).sort().reverse();
        if (indexed.length !== dates.length || indexed.some((date, i) => date !== dates[i])) {
          return await rebuildIndex(dataDir, dates);
        }
        return parsed;
      } catch {
        return await rebuildIndex(dataDir, dates);
      }
    },

    async listDates() {
      return scanDates(dataDir);
    },

    async search(query, limit = DEFAULT_SEARCH_LIMIT) {
      const needle = query.trim().toLowerCase();
      if (needle === "") return [];

      const hits: SearchHit[] = [];
      for (const date of await scanDates(dataDir)) {
        const day = await readDayFile(dataDir, date);
        if (day === null) continue;

        for (const section of day.sections) {
          if (section.kind === "items") {
            for (const item of section.items) {
              if (hits.length >= limit) return hits;
              if (!matches(needle, [item.title, item.en, item.zh])) continue;
              const hit: SearchHit = {
                date,
                section: section.title,
                title: item.title,
                en: item.en,
                zh: item.zh,
              };
              if (item.url !== undefined) hit.url = item.url;
              hits.push(hit);
            }
          } else {
            for (const category of section.categories) {
              for (const item of category.items) {
                if (hits.length >= limit) return hits;
                if (!matches(needle, [category.title, category.titleZh, item.en, item.zh])) continue;
                const hit: SearchHit = {
                  date,
                  section: section.title,
                  title: category.title,
                  en: item.en,
                  zh: item.zh,
                };
                if (item.url !== undefined) hit.url = item.url;
                hits.push(hit);
              }
            }
          }
        }
      }
      return hits;
    },
  };
}

function matches(needle: string, fields: string[]): boolean {
  return fields.some((field) => field.toLowerCase().includes(needle));
}
