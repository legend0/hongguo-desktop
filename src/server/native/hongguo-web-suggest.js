// SPDX-License-Identifier: GPL-3.0-only
/**
 * 官网搜索联想（/api/search/suggestion?query=）。
 * 移植自原主项目 @hongguo/scraper 的 search.api 方案：
 * 联想词为 XHR JSON（非 SSR），直接 GET 请求解析 suggestionList。
 * - 带 video_data（含 series_id）→ 剧集条目，可直接跳详情
 * - 其他（common_query 等）→ 纯关键词，回搜索页
 */
const axios = require('axios');
const logger = require('../services/logger');

const SITE = 'https://hongguoduanju.com';
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 8000;
const SUGGEST_TTL_MS = 60 * 1000; // 联想词 60 秒缓存（与原 scraper searchSuggest TTL 对齐）
const MAX_SUGGESTIONS = 10;

const cache = new Map(); // keyword -> { at, items }

/**
 * 获取搜索联想词（剧集条目 + 关键词条目），带 60 秒缓存。
 * @param {string} keyword - 搜索关键词（1~80 字）
 * @returns {Promise<Array<{kind: 'drama'|'keyword', name: string, keyword: string, coverUrl?: string, totalEpisodes?: number, heatText?: string, categories?: string[]}>>}
 * @throws {Error} 关键词非法或请求失败时抛出
 */
async function searchSuggest(keyword) {
  const kw = String(keyword ?? '').trim();
  if (!kw || kw.length > 80) throw new Error('搜索词需为 1 至 80 字的文本');

  const hit = cache.get(kw);
  if (hit && Date.now() - hit.at < SUGGEST_TTL_MS) return hit.items;

  const url = `${SITE}/api/search/suggestion?query=${encodeURIComponent(kw)}`;
  const res = await axios.get(url, {
    timeout: TIMEOUT_MS,
    headers: { 'user-agent': WEB_UA, accept: 'application/json' },
    responseType: 'json',
  });
  const list = Array.isArray(res.data?.suggestionList) ? res.data.suggestionList : [];

  const items = [];
  const seenKeys = new Set(); // 同一条目可能在 suggestionList 中重复出现（剧集按 series_id、关键词按文案去重）
  for (const it of list) {
    if (items.length >= MAX_SUGGESTIONS) break;
    const name = String(it?.name ?? '').trim();
    if (!name) continue;
    const v = it.video_data;
    if (v && /^\d{1,30}$/.test(String(v.series_id ?? ''))) {
      const sid = String(v.series_id);
      if (seenKeys.has(`d:${sid}`)) continue;
      seenKeys.add(`d:${sid}`);
      const cats = Array.isArray(v.category_list) ? v.category_list : [];
      items.push({
        kind: 'drama',
        name,
        keyword: sid,
        coverUrl: String(v.series_cover ?? '') || undefined,
        totalEpisodes: Number(v.episode_cnt) || undefined,
        heatText: v.hot_score_data && typeof v.hot_score_data === 'object' ? String(v.hot_score_data.text ?? '') || undefined : undefined,
        categories: cats.map((c) => String(c?.name ?? '')).filter(Boolean).slice(0, 2),
      });
    } else {
      if (seenKeys.has(`k:${name}`)) continue;
      seenKeys.add(`k:${name}`);
      items.push({ kind: 'keyword', name, keyword: name });
    }
  }

  cache.set(kw, { at: Date.now(), items });
  logger.info('HongguoWebSuggest', `搜索联想完成 keyword="${kw}": ${items.length} 条`);
  return items;
}

module.exports = { searchSuggest };
