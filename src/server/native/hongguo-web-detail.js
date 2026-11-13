// SPDX-License-Identifier: GPL-3.0-only
/**
 * 官网详情页（/detail?series_id=）附加数据：热评 + 推荐位 + 热门榜单。
 * 移植自原主项目 @hongguo/scraper 的 detail.adapter 方案：
 * - SSR router 数据（data-fn-args 脚本）→ 推荐位 videoList / 热门 hot_list
 * - SSR 直出的剧评 article 卡片 → 热评（标题/评分/内容/作者/时间/点赞）
 */
const cheerio = require('cheerio');
const axios = require('axios');
const logger = require('../services/logger');
const { cleanTitle } = require('./hongguo-app-search');

const SITE = 'https://hongguoduanju.com';
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const DETAIL_TTL_MS = 2 * 3600 * 1000; // 2小时缓存

const cache = new Map(); // series_id -> { at, extras }

/** 官网页面解析选择器（class 为服务端 CSS Modules 哈希，用前缀模糊匹配） */
const SEL = {
  routerDataScript: 'script[data-fn-args]',
  reviewCard: 'article[class*="mobile-review-card-"]',
  reviewPublishedAt: 'time[class*="review-published-at-"]',
  reviewContent: 'p[class*="review-content-"]',
  reviewAvatar: 'div[class*="review-meta-"] img',
  reviewName: 'span[class*="user-name-"]',
  reviewRating: 'span[class*="rating-"]',
  reviewLikes: 'small',
  reviewTotalText: 'header[class*="review-header-"] span',
};

/** SSR router 数据的载荷键名与推荐位视频字段名（与原 scraper config 对齐） */
const K = {
  detailRoute: 'detail_page',
  recommendKey: 'recommendations',
  groupsKey: 'recommendationGroups',
  hotListKey: 'hot_list',
  videoListKey: 'videoList',
  groupKeyField: 'key',
  groupArgsField: 'routerDataFnArgs',
};
const V = {
  id: 'series_id',
  title: 'series_name',
  titleAlt: 'series_title',
  cover: 'series_cover',
  intro: 'series_intro',
  episodeCnt: 'episode_cnt',
  tags: 'tags',
};

/**
 * 安全 JSON.parse。
 * @param {string} s - 待解析字符串
 * @returns {unknown} 解析失败返回 null
 */
function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

/**
 * 提取文本（保留内部换行）。
 * @param {cheerio.Cheerio<never>} $el - cheerio 节点
 * @returns {string}
 */
function textOf($el) {
  return ($el.text() || '').replace(/\u00a0/g, ' ').trim();
}

/**
 * 推荐位视频原始对象 → 渲染层卡片原始结构（供 ipc 适配层 toCard 消费）。
 * @param {Record<string, unknown>} v - router 数据中的视频对象
 * @returns {{series_id: string, series_title: string, cover: string, episode_count: number, tags: string[], description: string} | null}
 */
function mapRecommendation(v) {
  if (!v || typeof v !== 'object') return null;
  const id = String(v[V.id] ?? '');
  const title = cleanTitle(String(v[V.title] ?? v[V.titleAlt] ?? ''));
  if (!/^\d{1,30}$/.test(id) || !title) return null;
  return {
    series_id: id,
    series_title: title,
    cover: String(v[V.cover] ?? ''),
    episode_count: Number(v[V.episodeCnt]) || 0,
    tags: Array.isArray(v[V.tags]) ? v[V.tags].map((t) => cleanTitle(String(t))).filter(Boolean).slice(0, 4) : [],
    description: cleanTitle(String(v[V.intro] ?? '')),
  };
}

/**
 * 浅合并两个载荷对象：数组字段拼接、标量/对象字段后者覆盖。
 * @param {Record<string, unknown>|null} a - 已有载荷
 * @param {Record<string, unknown>|null} b - 新载荷
 * @returns {Record<string, unknown>}
 */
function mergePayload(a, b) {
  if (!a || typeof a !== 'object') return b ?? {};
  if (!b || typeof b !== 'object') return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = Array.isArray(v) && Array.isArray(out[k]) ? [...out[k], ...v] : v;
  }
  return out;
}

/**
 * 解析 SSR router 数据：兼容老版 _ROUTER_DATA 与新版 script[data-fn-args] 两种格式。
 * data-fn-args 结构为 [routeId, [{key, routerDataFnArgs: ["<json字符串>", ...]}], ...]，
 * routerDataFnArgs 每项是字符串化的 JSON 参数，需二次解析后按 key 归并为路由载荷。
 * @param {cheerio.CheerioAPI} $ - 详情页 DOM
 * @returns {Array<{routeId: string, data: Record<string, unknown>}>} 每个路由的载荷
 */
function parseRouterData($) {
  const payloads = [];
  const legacy = tryParseJson($('#_ROUTER_DATA').html() || '');
  if (legacy && typeof legacy === 'object') {
    const loaderData = legacy.loaderData ?? {};
    for (const [routeId, data] of Object.entries(loaderData)) {
      if (data && typeof data === 'object') payloads.push({ routeId, data });
    }
  }
  $(SEL.routerDataScript).each((_, el) => {
    const parsed = tryParseJson($(el).attr('data-fn-args') || '');
    if (!Array.isArray(parsed) || parsed.length < 2) return;
    const routeId = String(parsed[0] ?? '');
    const groups = Array.isArray(parsed[1]) ? parsed[1] : [];
    const existing = payloads.find((p) => p.routeId === routeId);
    const data = existing?.data ?? {};
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const key = String(g[K.groupKeyField] ?? '');
      if (!key) continue;
      const fnArgs = Array.isArray(g[K.groupArgsField]) ? g[K.groupArgsField] : [];
      let merged = {};
      for (const a of fnArgs) {
        const obj = typeof a === 'string' ? tryParseJson(a) : a;
        if (obj && typeof obj === 'object') merged = mergePayload(merged, obj);
      }
      if (Object.keys(merged).length > 0) data[key] = mergePayload(data[key], merged);
    }
    if (existing) existing.data = data;
    else payloads.push({ routeId, data });
  });
  return payloads;
}

/**
 * 从 router 载荷中提取推荐位视频列表（detail_page 路由的 recommendations.videoList）。
 * @param {Array<{routeId: string, data: Record<string, unknown>}>} payloads - parseRouterData 结果
 * @returns {Array<ReturnType<typeof mapRecommendation>>} 去重后的推荐卡片
 */
function extractVideoList(payloads) {
  const detail = payloads.find((p) => p.routeId === K.detailRoute) ?? payloads[0];
  if (!detail) return [];
  const rec = detail.data[K.recommendKey];
  if (!rec || typeof rec !== 'object') return [];
  const videoList = rec[K.videoListKey];
  if (!Array.isArray(videoList)) return [];
  const seen = new Set();
  const out = [];
  for (const v of videoList) {
    const item = mapRecommendation(v);
    if (item && !seen.has(item.series_id)) {
      seen.add(item.series_id);
      out.push(item);
    }
  }
  return out;
}

/**
 * 从 router 载荷中提取热门列表（recommendationGroups 中 key=hot_list 分组的 videoList）。
 * @param {Array<{routeId: string, data: Record<string, unknown>}>} payloads - parseRouterData 结果
 * @returns {Array<ReturnType<typeof mapRecommendation>>} 热门卡片
 */
function extractHotList(payloads) {
  const detail = payloads.find((p) => p.routeId === K.detailRoute) ?? payloads[0];
  if (!detail) return [];
  const rec = detail.data[K.recommendKey];
  if (!rec || typeof rec !== 'object') return [];
  const groups = rec[K.groupsKey];
  if (!Array.isArray(groups)) return [];
  for (const g of groups) {
    if (g && g[K.groupKeyField] === K.hotListKey && Array.isArray(g[K.groupArgsField])) {
      for (const args of g[K.groupArgsField]) {
        // 子分组的 fnArgs 元素可能是字符串化 JSON，需再解析一次
        const obj = typeof args === 'string' ? tryParseJson(args) : args;
        if (obj && typeof obj === 'object' && Array.isArray(obj.videoList)) {
          return obj.videoList.map(mapRecommendation).filter(Boolean);
        }
      }
    }
  }
  return [];
}

/**
 * 解析 SSR 直出的热评卡片。
 * @param {cheerio.CheerioAPI} $ - 详情页 DOM
 * @returns {{reviews: Array, reviewTotal: number}} 热评列表与总数
 */
function parseReviews($) {
  const reviews = [];
  $(SEL.reviewCard).each((_, el) => {
    const card = $(el);
    const content = cleanTitle(textOf(card.find(SEL.reviewContent).first()));
    if (!content) return;
    const author = cleanTitle(textOf(card.find(SEL.reviewName).first())) || '匿名用户';
    const avatar = String(card.find(SEL.reviewAvatar).first().attr('src') ?? '');
    const publishedAt = textOf(card.find(SEL.reviewPublishedAt).first()) || undefined;
    const rating = parseFloat(textOf(card.find(SEL.reviewRating).first())) || undefined;
    const likes = parseInt(textOf(card.find(SEL.reviewLikes).first()).replace(/\D/g, ''), 10) || 0;
    reviews.push({ author, authorAvatarUrl: avatar || undefined, publishedAt, rating, content, likes: likes || undefined });
  });
  const totalText = textOf($(SEL.reviewTotalText).first());
  const m = /(\d+)/.exec(totalText);
  const reviewTotal = m ? parseInt(m[1], 10) : reviews.length;
  return { reviews, reviewTotal };
}

/**
 * 获取官网详情页附加数据（热评 + 推荐位 + 热门），带 2 小时缓存。
 * @param {string|number} seriesId - 剧集编号
 * @returns {Promise<{reviews: Array, reviewTotal: number, recommendations: Array, hotRecommendations: Array}>}
 * @throws {Error} 请求失败或页面结构异常时抛出
 */
async function getWebDetailExtras(seriesId) {
  const id = String(seriesId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.extras;

  const url = `${SITE}/detail?series_id=${encodeURIComponent(id)}`;
  const res = await axios.get(url, {
    timeout: TIMEOUT_MS,
    headers: { 'user-agent': WEB_UA, accept: 'text/html' },
    responseType: 'text',
  });
  const $ = cheerio.load(res.data);
  const payloads = parseRouterData($);
  if (payloads.length === 0) {
    logger.warn('HongguoWebDetail', `详情页未发现 router 数据 sid=${id}`);
  }
  const { reviews, reviewTotal } = parseReviews($);
  const extras = {
    reviews,
    reviewTotal,
    recommendations: extractVideoList(payloads),
    hotRecommendations: extractHotList(payloads),
  };
  cache.set(id, { at: Date.now(), extras });
  return extras;
}

module.exports = { getWebDetailExtras };
