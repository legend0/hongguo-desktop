// SPDX-License-Identifier: GPL-3.0-only
// 播放取址模块门面：App 端播放地址获取的唯一对外入口。
// 迁移自 app-source.js（fetchAppPlayUrl/fetchAppPlayUrlInner/取址熔断器），
// 并按参考项目 PR#106 将播放域签名切换至 v5 移动端机制（见 v5-sign.js）。
const logger = require('../services/logger');
const { getPlaybackDevice, DEFAULT_PROFILE } = require('../native/playback-device');
const { normalizeDownloadQuality } = require('../native/download-quality');
const { resolveViaOpenhongguo } = require('../native/openhongguo-fallback');
const { resolveUpstreamEntry, clearEntryCache, entryCache } = require('./upstream');
const { parseEntryPlayInfo, isHevcCodec } = require('./entry');

/** 取址失败熔断：滑动窗口时长（仅统计 EMPTY_RESPONSE / BUSINESS_REJECTED 两类"服务端拒绝"失败） */
const FAILURE_WINDOW_MS = 60 * 1000;
/** 窗口内允许的失败次数上限（达到即熔断） */
const FAILURE_BUDGET = 5;
/** 熔断持续时间（期间直接快速失败，不再请求取址/设备接口，防风控窗口期高频重试放大风险） */
const CIRCUIT_OPEN_MS = 45 * 1000;
/** 滑动窗口内的取址失败时间戳 */
let playFailureTimestamps = [];
/** 熔断开启时刻（0 = 未熔断） */
let playCircuitOpenedAt = 0;

/** 记录一次取址失败；60s 窗口内累计 ≥5 次则开启熔断 */
function recordPlayFailure() {
    const now = Date.now();
    playFailureTimestamps = playFailureTimestamps.filter(t => now - t < FAILURE_WINDOW_MS);
    playFailureTimestamps.push(now);
    if (playFailureTimestamps.length >= FAILURE_BUDGET) playCircuitOpenedAt = now;
}

/** 熔断检查：开启期内抛 RATE_LIMITED 快速失败；冷却结束后清零预算重新计数 */
function assertCircuitClosed() {
    const now = Date.now();
    if (playCircuitOpenedAt && now - playCircuitOpenedAt < CIRCUIT_OPEN_MS) {
        const wait = Math.ceil((CIRCUIT_OPEN_MS - (now - playCircuitOpenedAt)) / 1000);
        throw Object.assign(new Error(`取址失败过于频繁，请 ${wait}s 后重试`), { code: 'RATE_LIMITED' });
    }
    if (playCircuitOpenedAt) {
        playCircuitOpenedAt = 0;
        playFailureTimestamps = [];
    }
}

// 同 vid 并发共享（vid -> Promise）：StrictMode 双挂载/双击重试会让签名请求翻倍，放大风控风险
const playInflight = new Map();

/**
 * 在途共享等待者与底层任务解耦取消：底层 promise 绑定的超时信号由主任务持有，
 * 等待者各自的 abort 信号只影响自身返回（提前 reject），不波及其它共享者（任务 85）。
 * @param {Promise<Object>} p - 共享的取址 promise
 * @param {AbortSignal} [signal] - 当前等待者的取消信号
 * @returns {Promise<Object>} 仅受当前等待者 signal 与底层任务结果影响的 promise
 */
function detachSignal(p, signal) {
    if (!signal) return p;
    if (signal.aborted) {
        return Promise.reject(Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' }));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' }));
        signal.addEventListener('abort', onAbort, { once: true });
        p.then(
            (v) => {
                signal.removeEventListener('abort', onAbort);
                resolve(v);
            },
            (e) => {
                signal.removeEventListener('abort', onAbort);
                reject(e);
            },
        );
    });
}

/**
 * App 端取址入口（含失败熔断 + 并发去重）：
 * - 每次调用先做熔断检查（60s 内 ≥5 次服务端拒绝失败 → 45s 内快速失败）；
 * - 仅统计 EMPTY_RESPONSE / BUSINESS_REJECTED（服务端拒绝类），网络/超时类不计入，
 *   避免弱网环境被误熔断；
 * - 并发去重按「vid + 全部解析参数」为键共享同一次取址（任务 85），refresh=true 不参与；
 *   等待者各自的 abort 信号经 detachSignal 解耦，只取消自身不波及其它共享者。
 * @param {string} vid - 分集编号
 * @param {{quality?: string, allowLowerQuality?: boolean, allowBytevc2?: boolean, allowHevc?: boolean, allowHevcTranscode?: boolean, refresh?: boolean, nextVid?: string, nextVids?: string[], signal?: AbortSignal}} [options] - 取址选项
 * @returns {Promise<Object>} 播放信息（首选变体 + variants 全集 + duration）
 * @throws {Error} RATE_LIMITED / EMPTY_RESPONSE / BUSINESS_REJECTED 等取址错误
 */
async function fetchAppPlayUrl(vid, options = {}) {
    assertCircuitClosed();
    // 共享键纳入全部解析参数：不同清晰度/HEVC 能力/续播预取参数的调用不共享结果，
    // 避免后到者拿到按首个调用者参数过滤的变体（任务 85）
    const key = [
        String(vid || ''),
        options.quality ?? '',
        options.allowLowerQuality === true ? 'lq' : '',
        options.allowBytevc2 === true ? 'bv2' : '',
        options.allowHevc === false ? 'nohevc' : '',
        options.allowHevcTranscode === true ? 'hevcTc' : '',
        options.nextVid ? String(options.nextVid) : '',
        Array.isArray(options.nextVids) ? options.nextVids.join(',') : '',
    ].join('|');
    if (!options.refresh && playInflight.has(key)) {
        return detachSignal(playInflight.get(key), options.signal);
    }
    const p = (async () => {
        try {
            return await fetchAppPlayUrlInner(vid, options);
        } catch (error) {
            if (error.code === 'EMPTY_RESPONSE' || error.code === 'BUSINESS_REJECTED') recordPlayFailure();
            throw error;
        }
    })().finally(() => playInflight.delete(key));
    if (!options.refresh) playInflight.set(key, p);
    return p;
}

/**
 * 取址内部实现：缓存命中直读 → 上游取址（三轮设备阶梯）→ 片源解析；
 * 空响应/缺模型类失败追加 openhongguo SDK 终局兜底（任务 63 追加）。
 * @param {string} vid - 分集编号
 * @param {{quality?: string, allowLowerQuality?: boolean, allowBytevc2?: boolean, allowHevc?: boolean, allowHevcTranscode?: boolean, refresh?: boolean, nextVid?: string, nextVids?: string[], signal?: AbortSignal}} [options] - 取址选项
 * @returns {Promise<Object>} 播放信息
 * @throws {Error} 兜底耗尽后上抛原始错误
 */
async function fetchAppPlayUrlInner(vid, options = {}) {
    const requestedQuality = normalizeDownloadQuality(options.quality);
    const allowLowerQuality = options.allowLowerQuality === true && requestedQuality !== 'auto';
    vid = String(vid || '');
    if (!/^\d{1,30}$/.test(vid)) throw new Error('分集编号无效');
    const deadline = Date.now() + 12000;
    const timeoutSignal = AbortSignal.timeout(12000);
    // 底层任务只绑超时信号（任务 85）：等待者的个人取消由共享层 detachSignal 解耦，
    // 避免首个调用者 abort 使共享中的其它等待者一并失败；12s 超时兜底仍然生效
    const signal = timeoutSignal;
    // 当前设备机型档案（同步读取内存/持久化身份，不触发注册请求），用于流 UA 与设备参数一致
    const profile = getPlaybackDevice.currentProfile?.() || DEFAULT_PROFILE;
    // HEVC 能力透传（渲染层硬解探测结果；allowHevcTranscode 表示可用 ffmpeg 兜底转码）
    const allowHevc = options.allowHevc !== false;
    const allowHevcTranscode = options.allowHevcTranscode === true;

    if (!options.refresh && entryCache.has(vid)) {
        const cached = entryCache.get(vid);
        if (cached?.expires > Date.now()) {
            try {
                return await parseEntryPlayInfo(vid, cached.entry, requestedQuality, allowLowerQuality, deadline, signal, options.allowBytevc2 === true, allowHevc, allowHevcTranscode, profile);
            } catch (error) {
                if (error.code === 'UNSUPPORTED_BYTEVC2' || error.code === 'UNSUPPORTED_HEVC') throw error;
                entryCache.delete(vid);
            }
        } else {
            entryCache.delete(vid);
        }
    }

    const batch = [vid];
    const extra = Array.isArray(options.nextVids) ? options.nextVids : options.nextVid ? [options.nextVid] : [];
    for (const next of extra) {
        const nVid = String(next || '');
        if (/^\d{1,30}$/.test(nVid) && !batch.includes(nVid)) {
            batch.push(nVid);
            if (batch.length >= 4) break;
        }
    }

    // 终局兜底（任务 63 追加）：自研三轮设备阶梯全空响应时，改经 openhongguo SDK
    // （clean-room 签名 + 独立匿名设备，内部自带换机互斥与 2 台上限）解析一次；
    // 仅空响应类失败才兜底（业务拒绝/编码不支持等设备无关错误直接上抛）
    try {
        const currentEntry = await resolveUpstreamEntry(vid, batch, options.refresh === true, signal);
        return await parseEntryPlayInfo(vid, currentEntry, requestedQuality, allowLowerQuality, deadline, signal, options.allowBytevc2 === true, allowHevc, allowHevcTranscode, getPlaybackDevice.currentProfile?.() || DEFAULT_PROFILE);
    } catch (error) {
        if (error.code !== 'EMPTY_RESPONSE' && error.code !== 'MISSING_MODEL') throw error;
        logger.warn('PlaySource', '自研取址阶梯耗尽，尝试 openhongguo SDK 兜底...');
        const fallback = await resolveViaOpenhongguo(vid, { signal, timeoutMs: Math.max(3000, deadline - Date.now()) });
        if (!fallback) throw error;
        return fallback;
    }
}

module.exports = { fetchAppPlayUrl, clearEntryCache, isHevcCodec };
