import type { DramaCard } from '../types';
import { api } from '../api';

/** 季信息解析结果 */
export interface SeasonInfo {
  /** 去掉季标后的基础剧名（如《和离后我带女儿横扫魔域》） */
  baseTitle: string;
  /** 季数（中文/阿拉伯数字均归一化，无显式季标为 1） */
  seasonNum: number;
  /** 展示文案（如"第2季"） */
  seasonLabel: string;
  /** 标题是否显式带季标（无季标的"第 1 季"= 系列首部，isExplicit=false） */
  isExplicit: boolean;
}

/** 标题尾部季标匹配（第2季 / 第二部 / Season 3 / (2) 等，参考 hongguo-open-player 方案） */
const SEASON_PATTERNS = [
  /[（(【\s]*第\s*([0-9零一二两三四五六七八九十]+)\s*(?:季|部|期|辑)[）)】\s]*$/i,
  /[（(【\s]*([0-9零一二两三四五六七八九十]+)\s*(?:季|部|期|辑)[）)】\s]*$/i,
  /[（(【\s]*(?:Season|S)\s*([0-9]+)[）)】\s]*$/i,
  /[（(【]\s*([0-9]+)\s*[）)】]$/i,
  /** 站点多季短剧常用的"裸数字尾标"（《…我终于发达了10》）。
   *  [0-9]+ 贪婪匹配整个数字串：4 位年份（>100）会被 parseSeasonInfo 的 num≤100 校验整体拒绝，
   *  不会出现"截取末两位"的误伤。放在最后，带季标的形式优先。 */
  /[（(【\s]*([0-9]+)[）)】\s]*$/,
];

/** 中文数字字符表 */
const CHINESE_NUMS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/**
 * 中文数字字符串转数值（支持 一~九、十X、X十、X十Y，上限 100）。
 * @param raw 模糊匹配捕获的数字串（中文或阿拉伯）
 * @returns 合法季数（1~100），无法解析返回 null
 */
function parseChineseNumber(raw: string): number | null {
  if (/^[0-9]+$/.test(raw)) return Number.parseInt(raw, 10);
  if (raw.length === 1 && CHINESE_NUMS[raw] !== undefined) return CHINESE_NUMS[raw];
  if (raw === '十') return 10;
  if (raw.length === 2 && raw[1] === '十' && CHINESE_NUMS[raw[0]] !== undefined) {
    return CHINESE_NUMS[raw[0]] * 10;
  }
  if (raw.length === 2 && raw[0] === '十' && CHINESE_NUMS[raw[1]] !== undefined) {
    return 10 + CHINESE_NUMS[raw[1]];
  }
  if (raw.length === 3 && CHINESE_NUMS[raw[0]] !== undefined && raw[1] === '十' && CHINESE_NUMS[raw[2]] !== undefined) {
    return CHINESE_NUMS[raw[0]] * 10 + CHINESE_NUMS[raw[2]];
  }
  return null;
}

/**
 * 从剧名解析季信息（站点无官方"同系列"接口，靠标题约定聚合，参考 hongguo-open-player）。
 * 例：《和离后我带女儿横扫魔域第二季》→ baseTitle="和离后我带女儿横扫魔域"、seasonNum=2。
 * 无显式季标时视为第 1 季（baseTitle 为去尾空白的原标题）。
 * @param rawTitle 原始剧名
 * @returns 季信息（空输入返回默认第 1 季）
 */
export function parseSeasonInfo(rawTitle: string | undefined | null): SeasonInfo {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return { baseTitle: '', seasonNum: 1, seasonLabel: '第1季', isExplicit: false };
  }
  const title = rawTitle.trim();
  for (const pattern of SEASON_PATTERNS) {
    const match = title.match(pattern);
    if (match) {
      const num = parseChineseNumber(match[1]);
      if (num && num > 0 && num <= 100) {
        const rawBase = title.slice(0, match.index).trim();
        const baseTitle = rawBase.replace(/[\s:：·_—\-]+$/, '').trim() || rawBase;
        if (baseTitle) {
          return { baseTitle, seasonNum: num, seasonLabel: `第${num}季`, isExplicit: true };
        }
      }
    }
  }
  const cleaned = title.replace(/[\s:：·_—\-]+$/, '').trim() || title;
  return { baseTitle: cleaned, seasonNum: 1, seasonLabel: '第1季', isExplicit: false };
}

/**
 * 基础剧名归一化（跨平台书名号/全半角/空白差异容错，用于同系列比对）。
 * @param title 剧名
 * @returns 归一化后的比对键
 */
export function normalizeBaseTitle(title: string | undefined | null): string {
  return (title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[：:]/g, ':')
    .replace(/[，,]/g, ',')
    .replace(/[！!]/g, '!')
    .replace(/[？?]/g, '')
    .replace(/[""'']/g, '')
    .replace(/\s+/g, '');
}

/**
 * 同系列查询结果缓存：键 = 归一化基础剧名。
 * 只缓存"匹配到 ≥2 部"的成功结果并带 30 分钟过期——搜索接口存在波动（限流/部分结果），
 * 若把只含当前季的单项结果也缓存，详情页将因 length≤1 永久不渲染同季模块（进程内无解）。
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const seasonsCache = new Map<string, { list: DramaCard[]; at: number }>();
/** 成员索引：剧 id → 所属系列缓存键。同系列靠标题搜索聚合，个别结果剥离季标后
 * 基础名仍与系列键不同（归一化差异/解析兜底），缓存未命中会重新搜索 → 波动时
 * 只搜到自己 → 分季模块消失；经分季卡片跳转的剧直接按 id 反查所属系列缓存。 */
const memberIndex = new Map<string, string>();

/**
 * 拉取同系列各季卡片（含当前季，按季数升序；探索来源 = 基础剧名搜索前两页）。
 * 过滤规则（任务 88，用户选定）：结果剧名剥离季标后归一化，与当前剧基础名**严格相等**才收录——
 * 原包含匹配（includes）会混入「剧名之XXX」式连写蹭名的其它影片，全等比对排除大部分增片；
 * 代价：《剧名：副标题》式跨平台副标题差异不再聚合（保守少显示优于错误聚合）。
 * 残留：与当前剧完全同名的另一部影片无法靠标题区分，维持收录。
 * 漫画条目排除。排序：季数升序 → 同季显式季标在前 → 集数多在前。
 * @param current 当前剧卡片（结果集锚点，保证当前季一定在列）
 * @returns 同系列各季（含当前季）；搜索失败时仅返回 [当前季]
 */
export async function fetchRelatedSeasons(current: DramaCard): Promise<DramaCard[]> {
  const { baseTitle } = parseSeasonInfo(current.title);
  if (!baseTitle) return [current];

  // 成员索引优先：从分季卡片跳转过来的剧按 id 反查所属系列缓存，直接复用列表
  const memberKey = memberIndex.get(current.id);
  if (memberKey) {
    const indexed = seasonsCache.get(memberKey);
    if (indexed && Date.now() - indexed.at < CACHE_TTL_MS && indexed.list.some((c) => c.id === current.id)) {
      return indexed.list;
    }
  }

  const normBase = normalizeBaseTitle(baseTitle);
  const cached = seasonsCache.get(normBase);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.list;
  if (cached) seasonsCache.delete(normBase); // 过期条目顺手清掉，防 Map 无限增长

  // 前两页搜索聚合：第 1 页必查；结果充足且还有更多时补第 2 页（同系列常有十几部）
  const page1 = await api.searchPage(baseTitle, 1);
  let list = [...(page1.items ?? [])];
  if (page1.hasMore && list.length >= 5) {
    try {
      const page2 = await api.searchPage(baseTitle, 2);
      list = list.concat(page2.items ?? []);
    } catch {
      // 第 2 页失败不影响第 1 页结果
    }
  }

  const seenIds = new Set<string>([current.id]);
  const result: DramaCard[] = [current];

  for (const item of list) {
    if (!item?.id || seenIds.has(item.id) || item.kind === 'comic') continue;
    const parsed = parseSeasonInfo(item.title);
    const itemNormBase = normalizeBaseTitle(parsed.baseTitle);
    // 严格相等（任务 88）：包含匹配会混入「剧名之XXX」式连写蹭名的其它影片
    if (itemNormBase === normBase) {
      seenIds.add(item.id);
      result.push({
        id: item.id,
        title: item.title,
        coverUrl: item.coverUrl,
        totalEpisodes: item.totalEpisodes ?? null,
        tags: item.tags ?? [],
      });
    }
  }

  // 预计算季信息后排序：季数升序 → 同季显式季标在前 → 集数多在前
  const parsed = result.map((card) => ({ card, info: parseSeasonInfo(card.title) }));
  parsed.sort((a, b) => {
    if (a.info.seasonNum !== b.info.seasonNum) return a.info.seasonNum - b.info.seasonNum;
    if (a.info.isExplicit && !b.info.isExplicit) return -1;
    if (!a.info.isExplicit && b.info.isExplicit) return 1;
    return (b.card.totalEpisodes ?? 0) - (a.card.totalEpisodes ?? 0);
  });
  const ordered = parsed.map((p) => p.card);

  // 只缓存多季结果：单项结果无缓存价值，缓存它只会让"本次搜索波动"变成"永久不显示"；
  // 同时登记成员索引，系列内任一剧跳转都能命中同系列缓存
  if (ordered.length > 1) {
    seasonsCache.set(normBase, { list: ordered, at: Date.now() });
    for (const card of ordered) memberIndex.set(card.id, normBase);
  }
  return ordered;
}
