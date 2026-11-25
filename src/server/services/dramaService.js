// SPDX-License-Identifier: GPL-3.0-only
const hg = require('../native/hongguo');
const hgSearch = require('../native/hongguo-search');
const hgAppSearch = require('../native/hongguo-app-search');
const hgCatalog = require('../native/hongguo-app-catalog');
const hgActor = require('../native/hongguo-actor');
const hongguoWebDetail = require('../native/hongguo-web-detail');
const hongguoWebSuggest = require('../native/hongguo-web-suggest');
const appSource = require('../native/app-source');
const logger = require('./logger');

class DramaService {
  constructor() {
    this.searchSessions = new Map();
    // 任务 63 风暴治理：短剧详情/分类列表的短 TTL 结果缓存 + 并发在途共享
    // （StrictMode 双挂载/双击会让同一请求连发两轮，直接放大上游请求量）
    /** @type {Map<string, {data: object, expires: number}>} 详情结果缓存（30s TTL） */
    this.detailCache = new Map();
    /** @type {Map<string, Promise<object>>} 详情在途请求（并发去重） */
    this.detailInflight = new Map();
    /** @type {Map<string, {data: object, expires: number}>} 分类列表结果缓存（15s TTL） */
    this.catalogCache = new Map();
    /** @type {Map<string, Promise<object>>} 分类列表在途请求（并发去重） */
    this.catalogInflight = new Map();
  }

  /**
   * 搜索短剧
   */
  async search(keyword, page = 1) {
    if (keyword === undefined || keyword === '') {
      return { results: [], total: 0, page: 1, hasMore: false };
    }
    if (typeof keyword !== 'string' || keyword.trim().length > 80) {
      throw Object.assign(new Error('搜索词需为 1 至 80 字的文本'), { status: 400 });
    }
    page = Number(page);
    if (!Number.isInteger(page) || page < 1 || page > 50) {
      throw Object.assign(new Error('页码需为 1 至 50 的整数'), { status: 400 });
    }
    const cleanKw = keyword.trim();
    if (!cleanKw) return { results: [], total: 0, page, hasMore: false };
    const t0 = Date.now();
    logger.info('DramaService', `开始搜索短剧 keyword="${cleanKw}", page=${page}`);
    try {
      const res = await hgSearch.searchHongguo(cleanKw, { page });
      if (res && Array.isArray(res.results) && res.success !== false) {
        logger.info('DramaService', `Web端搜索成功 keyword="${cleanKw}": 返回 ${res.results.length} 部短剧, 耗时 ${Date.now() - t0}ms`);
        return res;
      }
    } catch (e) {
      logger.warn('DramaService', `Web端搜索失败，尝试回退至App端搜索: ${e.message}`);
    }

    // 回退到 App 端搜索
    try {
      let session = this.searchSessions.get(cleanKw);
      if (page === 1 || !session || session.expires <= Date.now()) {
        session = { expires: Date.now() + 120000, cursors: new Map() };
        this.searchSessions.delete(cleanKw);
        this.searchSessions.set(cleanKw, session);
        if (this.searchSessions.size > 30) this.searchSessions.delete(this.searchSessions.keys().next().value);
      }
      const appRes = await hgAppSearch.searchApp(cleanKw, { page, cursor: session.cursors.get(page) });
      if (appRes?.hasMore && appRes.cursor) session.cursors.set(page + 1, appRes.cursor);
      logger.info('DramaService', `App端搜索完成 keyword="${cleanKw}": 返回 ${appRes?.results?.length || 0} 部短剧, 耗时 ${Date.now() - t0}ms`);
      return appRes || { results: [], total: 0, page: 1, hasMore: false };
    } catch (e) {
      logger.error('DramaService', `App端搜索失败 keyword="${cleanKw}": ${e.message}`);
      return { results: [], total: 0, page: 1, hasMore: false, error: e.message };
    }
  }

  /**
   * 浏览剧场列表/分类（任务 63：短 TTL 缓存 + 在途共享，吸收重复请求）
   */
  async catalog(options = {}) {
    const page = Number(options.page) || 1;
    const category = options.category || 'hot-drama';
    const genre = options.genre || '';
    const cacheKey = `${page}|${category}|${genre}`;
    const cached = this.catalogCache.get(cacheKey);
    if (cached?.expires > Date.now()) return cached.data;
    if (this.catalogInflight.has(cacheKey)) return this.catalogInflight.get(cacheKey);
    const p = this.fetchCatalog(page, category, genre).finally(() => this.catalogInflight.delete(cacheKey));
    this.catalogInflight.set(cacheKey, p);
    return p;
  }

  /**
   * 分类列表实际拉取（无去重，供 catalog 包装调用）。
   * 上游偶发故障（如 502）自动退避重试 2 次（300/800ms），仅重试瞬态错误
   * （网络异常 / 5xx / 429）；业务码错误（APP_BUSINESS 等）不重试。
   * @param {number} page - 页码
   * @param {string} category - 分类标识
   * @param {string} genre - 题材筛选
   * @returns {Promise<object>} 分类列表结果
   * @throws {Error} 非热播分类且 App 目录接口失败时抛出
   */
  async fetchCatalog(page, category, genre) {
    const t0 = Date.now();
    logger.info('DramaService', `获取分类短剧列表 category=${category}, genre="${genre}", page=${page}`);
    /** 协议层瞬时故障码：可退避重试（网络/超时/上游业务码偶发故障） */
    const TRANSIENT_CODES = ['APP_NETWORK', 'APP_TIMEOUT', 'APP_BUSINESS'];
    /** 瞬态错误判定：协议层 fail 的 code 白名单；无 code 的意外异常（网络层）也视为瞬态 */
    const isTransient = (e) => (e?.code ? TRANSIENT_CODES.includes(e.code) : true);
    /**
     * 协议层 fail 对象（{success:false, error, code, sourceUrl}）→ Error：
     * 透传真实原因（去掉"可重试或切换官网"尾巴），避免笼统的"结构异常"掩盖根因。
     * @param {object} res - browseList 返回的 fail 对象
     * @returns {Error} 带 code 的错误
     */
    const failOf = (res) => {
      const msg = String(res?.error || '目录接口响应结构异常').replace(/，?可重试或切换官网$/, '');
      const e = new Error(msg);
      e.code = res?.code;
      return e;
    };
    /** 重试退避间隔（ms）：首试 + 2 次重试 */
    const RETRY_DELAYS = [300, 800];
    let lastErr = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const res = await hgCatalog.browseList({ page, category, genre });
        if (res && res.success !== false && Array.isArray(res.results)) {
          logger.info('DramaService', `成功获取分类短剧: 返回 ${res.results.length} 部短剧, total=${res.total}, 耗时 ${Date.now() - t0}ms`);
          this.catalogCache.set(`${page}|${category}|${genre}`, { data: res, expires: Date.now() + 15000 });
          return res;
        }
        // 协议层失败对象（success:false）：真实原因在 res.error/res.code，记录后按码决定是否重试
        lastErr = failOf(res);
        logger.warn('DramaService', `App端目录返回失败(第 ${attempt + 1} 次尝试): code=${lastErr.code || '-'} message=${lastErr.message}`);
      } catch (e) {
        lastErr = e;
        logger.warn('DramaService', `App端目录请求异常(第 ${attempt + 1} 次尝试): ${e.message}`);
      }
      if (attempt < RETRY_DELAYS.length && isTransient(lastErr)) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      break;
    }
    logger.warn('DramaService', `App端目录多次尝试后仍失败: code=${lastErr?.code || '-'} message=${lastErr?.message || 'unknown'}`);

    // 会话游标失效（分页记录过期被丢弃）：重试同页永远无游标，引导用户刷新重建
    if (lastErr?.code === 'APP_CURSOR') {
      throw Object.assign(new Error('列表已过期，请刷新重新加载'), { status: 502 });
    }
    if (category !== 'hot-drama' || genre) {
      throw Object.assign(new Error(lastErr?.message || '所选分类暂不可用，请稍后重试'), { status: 502 });
    }
    // Only the general hot chart can fall back to a general hot search.
    try {
      const fallback = await this.search('热播', page);
      if (fallback && Array.isArray(fallback.results) && fallback.results.length > 0) {
        logger.info('DramaService', `热播降级搜索成功: 返回 ${fallback.results.length} 条, 耗时 ${Date.now() - t0}ms`);
        const wrapped = {
          results: fallback.results,
          page,
          total: fallback.total || fallback.results.length,
          hasMore: fallback.hasMore || false,
          fallback: true
        };
        this.catalogCache.set(`${page}|${category}|${genre}`, { data: wrapped, expires: Date.now() + 15000 });
        return wrapped;
      }
    } catch (e) {
      logger.error('DramaService', `热播降级搜索亦失败: ${e.message}`);
    }

    return { results: [], page, total: 0, hasMore: false };
  }

  /**
   * 获取剧集详情及全部分集列表（任务 63：短 TTL 缓存 + 在途共享，吸收重复请求）
   */
  async getSeriesDetail(seriesId) {
    if (!seriesId) throw new Error('缺少 series_id 参数');
    const sid = String(seriesId).trim();
    const cached = this.detailCache.get(sid);
    if (cached?.expires > Date.now()) return cached.data;
    if (this.detailInflight.has(sid)) return this.detailInflight.get(sid);
    const p = this.fetchSeriesDetail(sid).finally(() => this.detailInflight.delete(sid));
    this.detailInflight.set(sid, p);
    return p;
  }

  /**
   * 短剧详情实际拉取（无去重，供 getSeriesDetail 包装调用）
   * @param {string} sid - 剧集编号
   * @returns {Promise<object>} 详情与分集列表
   * @throws {Error} 未获取到分集列表时抛出
   */
  async fetchSeriesDetail(sid) {
    const t0 = Date.now();
    logger.info('DramaService', `正在获取短剧分集详情 seriesId=${sid}`);
    const data = await hg.fetchEpisodeList(sid);
    if (!data || !Array.isArray(data.episodes) || data.episodes.length === 0) {
      logger.error('DramaService', `未能获取到短剧分集列表 seriesId=${sid}`);
      throw new Error('未获取到该短剧的分集列表');
    }
    logger.info('DramaService', `成功获取短剧详情: 《${data.series_title || ''}》(seriesId=${sid}), 共 ${data.episodes.length} 集, 耗时 ${Date.now() - t0}ms`);
    const result = {
      series_id: sid,
      series_title: data.series_title || '',
      cover: data.cover || '',
      total: data.total || data.episodes.length,
      intro: data.intro || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      episode_label: data.episode_label || '',
      social_info: data.social_info || null,
      celebrities: Array.isArray(data.celebrities) ? data.celebrities : [],
      episodes: data.episodes.map(ep => ({
        vid: String(ep.vid),
        vid_index: Number(ep.vid_index),
        title: ep.title ? String(ep.title) : `第 ${ep.vid_index} 集`,
        series_id: sid,
        series_title: ep.series_title || data.series_title,
        cover: ep.cover || data.cover
      }))
    };
    this.detailCache.set(sid, { data: result, expires: Date.now() + 30000 });
    while (this.detailCache.size > 16) this.detailCache.delete(this.detailCache.keys().next().value);
    return result;
  }

  /**
   * 获取官网详情页附加数据（热评 + 推荐位 + 热门，原 @hongguo/scraper 方案）
   * @param {string|number} seriesId - 剧集编号
   * @returns {Promise<{reviews: Array, reviewTotal: number, recommendations: Array, hotRecommendations: Array}>}
   */
  async getWebDetailExtras(seriesId) {
    return hongguoWebDetail.getWebDetailExtras(seriesId);
  }

  /**
   * 搜索联想词（官网 /api/search/suggestion，原 @hongguo/scraper 方案）
   * @param {string} keyword - 搜索关键词
   * @returns {Promise<Array<{kind: string, name: string, keyword: string, coverUrl?: string, totalEpisodes?: number, heatText?: string, categories?: string[]}>>}
   */
  async searchSuggest(keyword) {
    return hongguoWebSuggest.searchSuggest(keyword);
  }

  /**
   * 解析单集视频播放源和加密信息
   * @param {string} vid - 分集 id
   * @param {string} [quality='1080p'] - 请求清晰度
   * @param {{nextVid?: string}} [options] - 可选参数
   * @param {string} [options.nextVid] - 下一集 id：随本次取址一并批量请求，
   *   结果进入 entryCache（180s TTL），下次切集直接命中缓存，零额外签名请求
   * @returns {Promise<object>} 单集播放元信息（含 url/variants/contentKeyHex 等）
   */
  async getPlayInfo(vid, quality = '1080p', options = {}) {
    if (!vid) throw new Error('缺少 vid 参数');
    const t0 = Date.now();
    logger.info('DramaService', `解析单集播放元信息 vid=${vid}, quality=${quality}${options?.nextVid ? `, 预取下一集=${options.nextVid}` : ''}`);
    const playInfo = await appSource.fetchAppPlayUrl(String(vid), {
      quality, allowLowerQuality: true,
      // 播放探测路径与流端点对齐：本集仅含 ByteVC2 档时不再提前误杀
      // （真正播放走 streamService 流式转码，此处结果仅用于快速失败校验与预取）
      allowBytevc2: true,
      ...(options?.nextVid ? { nextVid: options.nextVid } : {}),
    });
    if (!playInfo || !playInfo.url) {
      logger.error('DramaService', `未能解析到有效的播放地址 vid=${vid}`);
      throw new Error('未能解析到有效的播放地址');
    }
    const hasKey = !!playInfo.contentKey;
    const variantsCount = Array.isArray(playInfo.variants) ? playInfo.variants.length : 1;
    logger.info('DramaService', `播放元信息解析完成 vid=${vid}: 编码=${playInfo.codec || 'hevc'}, 清晰度=${playInfo.quality || quality}, 候选节点数=${variantsCount}, 解密Key=${hasKey ? '就绪' : '无'}, 耗时 ${Date.now() - t0}ms`);
    return {
      vid: String(vid),
      url: playInfo.url,
      codec: playInfo.codec || 'hevc',
      quality: playInfo.quality || quality,
      contentKeyHex: playInfo.contentKey ? (Buffer.isBuffer(playInfo.contentKey) ? playInfo.contentKey.toString('hex') : String(playInfo.contentKey)) : null,
      variants: Array.isArray(playInfo.variants) ? playInfo.variants.map(v => ({
        quality: v.quality,
        codec: v.codec,
        url: v.url
      })) : []
    };
  }

  /**
   * 获取剧星榜（演员排行榜）
   */
  async getActorRankings(options = {}) {
    return hgActor.fetchActorRankings(options);
  }

  /**
   * 获取演员主页详情
   */
  async getActorDetail(actorId) {
    return hgActor.fetchActorDetail(actorId);
  }

  /**
   * 获取演员参演短剧作品
   */
  async getActorWorks(actorId, options = {}) {
    return hgActor.fetchActorWorks(actorId, options);
  }
}

module.exports = new DramaService();
