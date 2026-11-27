// SPDX-License-Identifier: GPL-3.0-only
// 播放域请求构造：v5 移动端签名播放请求 + 番茄短剧降级请求。
// 迁移自 app-source.js（playbackRequest/shortplayRequest），并按参考项目
// zfdang/hongguo-open-player PR#106（commit 48f956f）切换至 v5 签名机制。
const { gzipSync } = require('node:zlib');
const loginState = require('../native/login-state');
const { PlayerSigner } = require('../native/argus');
const { signPlaybackV5 } = require('./v5-sign');
const { pythonUrlEncode } = require('./util');

// v5 播放 query 固定参数：官方 7.4.5.32 update_64 渠道 + Redmi 25053RT47C 机型
// （对照 hongguoTV MobilePlayback.kt currentApp 分支，2026-11 最新 main；
//  旧 7.4.3.32 vivo/PGT-AN10 player/v1 协议已被上游风控空响应，不再使用）
const V5_PLAYBACK_QUERY = {
    aid: '8662', app_name: 'novelread', version_code: '74532', version_name: '7.4.5.32',
    update_version_code: '74532', manifest_version_code: '74532',
    os: 'android', ssmix: 'a', channel: 'update_64', device_platform: 'android',
    device_type: '25053RT47C', device_brand: 'Redmi', os_version: '16', os_api: '36',
    ac: 'wifi', language: 'zh', host_abi: 'arm64-v8a',
};
// v5 播放 UA：currentApp 分支使用 Android http.agent（Dalvik 形态），
// 机型/系统/Build 串与 video_tab UA 同源（25053RT47C / Android 16 / BP2A.250605.031.A3）
const V5_PLAYBACK_UA = 'Dalvik/2.1.0 (Linux; U; Android 16; 25053RT47C Build/BP2A.250605.031.A3)';
// video_tab 兜底 UA：官方 7.3.9.32 Cronet 形态，机型/系统随 currentApp 档
// （对照 hongguoTV MobilePlayback.kt videoTabRequest UA）
const V5_VIDEO_TAB_UA = 'com.phoenix.read/73932 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';

// 番茄小说客户端短剧接口（aid 1967）：红果播放域全受阻时的降级通道
const SHORTPLAY_APIS = [
    'https://api3-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/',
    'https://api5-normal-lq.fqnovel.com/novel/player/video_model/v1/',
    'https://reading.snssdk.com/novel/player/video_model/v1/',
];
const SHORTPLAY_API = SHORTPLAY_APIS[0];

// video_tab 兜底端点（参考 hongguoTV 478f006：PlayRetryPlan.hosts 首选域名，单次请求）
const VIDEO_TAB_API = 'https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/';

// 全集目录端点阶梯（参考 hongguoTV tabGate.hosts，2026-11-27 官网 vid_list 混淆后的全集来源）：
// 官网 player 页 vid_list 只下发 v1_ 不透明标识后，改走站方 App 目录接口拿全量纯数字 item_id
const DIRECTORY_APIS = [
    'https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/directory/all_items/v/',
    'https://api5-normal-hl.fqnovel.com/reading/bookapi/directory/all_items/v/',
];

/**
 * 构造 v5 移动端签名的播放域请求（v04.10.03 机制，PR#106）。
 * v3 medusa 被当前播放端点以空 200 拒绝；v5 将注册设备三要素同时绑定进
 * query 与 medusa 明文，请求头只发 x-khronos/x-helios/x-medusa/x-ss-stub/Content-Type
 * （不再有 x-argus/x-ladon/x-gorgon/x-ss-req-ticket）。
 * Cookie 仍由本函数合并（设备 Cookie + 用户登录态），设备会话 Jar 的注入由传输层完成。
 * @param {string} payload - 业务 JSON 请求体（明文，函数内部 gzip）
 * @param {{device_id?: string, iid?: string, cdid?: string, cookie?: string}} identity - 注册设备身份（仅取三要素与 Cookie，会话/诊断字段不得进 query）
 * @param {string} apiBase - 播放端点（多端点阶梯中的一条）
 * @returns {{url: string, body: Buffer, headers: Object<string,string>}} 签名后请求
 */
function playbackRequestV5(payload, identity, apiBase) {
    const body = gzipSync(Buffer.from(payload));
    const { device_id = '', iid = '', cdid = '' } = identity || {};
    const values = {
        ...V5_PLAYBACK_QUERY,
        iid: iid || '', cdid: cdid || '', device_id: device_id || '',
    };
    const { url, headers: signedHeaders } = signPlaybackV5(apiBase, values, body);
    const headers = {
        'User-Agent': V5_PLAYBACK_UA, Accept: 'application/json',
        'Content-Encoding': 'gzip',
        ...signedHeaders,
    };
    // 设备 Cookie：注册时捕获的 set-cookie（无则按 install_id 兜底）；
    // 登录态请求头（x-tt-token / 用户 Cookie）合并在后（任务 26 本机增强）
    const cookieHeader = identity?.cookie || (iid ? `store-region=cn-bj; store-region-src=did; install_id=${iid}` : '');
    const authHeaders = loginState.authHeaders();
    if (cookieHeader || authHeaders.Cookie) {
        headers.Cookie = [cookieHeader, authHeaders.Cookie].filter(Boolean).join('; ');
    }
    return { url, body, headers };
}

/**
 * 构造 video_tab GET 同身份兜底请求（参考 hongguoTV 478f006 tabVideoModel strict 形态）：
 * v5 播放元数据偶发"空 200"时，用当前注册身份对该端点 GET 重查当前集。
 * 签名复用 v5 机制（同 V5_PLAYBACK_QUERY 设备参数 + 注册三要素，不重新注册）；
 * GET 无请求体（无 Content-Type/x-ss-stub），业务参数按 GetVideoModelRequest 的
 * snake_case 编入 query（缺任一字段服务端回 100103 PARAM_INVALID）。
 * @param {string} vid - 当前分集编号（video_id 严格精确匹配，不取他集）
 * @param {{device_id?: string, iid?: string, cdid?: string, cookie?: string}} identity - 注册设备身份（仅取三要素与 Cookie，会话/诊断字段不得进 query）
 * @param {string} [apiBase] - video_tab 端点（默认参考项目首选域名）
 * @returns {{url: string, headers: Object<string,string>}} 签名后请求（GET，无 body）
 * @throws {Error} v5 签名分支试探未命中时抛出
 */
function videoTabRequest(vid, identity, apiBase = VIDEO_TAB_API) {
    const { device_id = '', iid = '', cdid = '' } = identity || {};
    const values = {
        ...V5_PLAYBACK_QUERY,
        iid: iid || '', cdid: cdid || '', device_id: device_id || '',
        video_id: String(vid), video_id_type: '0', device_level: '1',
        need_all_video_definition: '1', need_mp4_align: '0', use_os_player: '0',
        video_platform: '1024', source: '0', from_video_id: '',
    };
    const { url, headers: signedHeaders } = signPlaybackV5(apiBase, values, null);
    const headers = {
        'User-Agent': V5_VIDEO_TAB_UA, Accept: 'application/json; charset=utf-8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...signedHeaders,
    };
    // 设备 Cookie 与登录态合并口径与 playbackRequestV5 一致（同身份同会话）
    const cookieHeader = identity?.cookie || (iid ? `store-region=cn-bj; store-region-src=did; install_id=${iid}` : '');
    const authHeaders = loginState.authHeaders();
    if (cookieHeader || authHeaders.Cookie) {
        headers.Cookie = [cookieHeader, authHeaders.Cookie].filter(Boolean).join('; ');
    }
    return { url, headers };
}

/**
 * 构造番茄小说短剧降级请求（aid 1967，PlayerSigner v3 签名，对照 demo PR#92）。
 * 红果播放域通道与设备全部受阻时的降级通道（buildPlaybackSteps 异构备通道）。
 * @param {string} vid - 分集编号
 * @param {{device_id?: string, iid?: string, cdid?: string, cookie?: string}} identity - 设备身份（仅取三要素与 Cookie）
 * @param {string} [apiBase] - 短剧端点（默认主通道）
 * @returns {{url: string, body: Buffer, headers: Object<string,string>}} 签名后请求
 */
function shortplayRequest(vid, identity, apiBase = SHORTPLAY_API) {
    const { profile: _omitProfile, ...ids } = identity || {};
    const khronos = Math.floor(Date.now() / 1000);
    const query = pythonUrlEncode({
        iid: ids.iid || '',
        device_id: ids.device_id || '',
        aid: '1967',
        app_name: 'novelapp',
        version_code: '72132',
        version_name: '7.2.1.32',
        device_platform: 'android',
        device_brand: 'Xiaomi',
        os_version: '13',
        cdid: ids.cdid || '',
    });
    const url = `${apiBase}?${query}`;
    const payload = JSON.stringify({
        video_id: String(vid),
        content_type: 1004,
        biz_param: {
            detail_page_version: 0, device_level: 3, disable_digg_stat: false, disable_video_relate_book: false,
            from_video_id: '', need_all_video_definition: true, need_mp4_align: false, source: 4,
            use_os_player: false, use_server_dns: false, video_platform: 3,
        },
    });
    const body = Buffer.from(payload);
    const signerHeaders = PlayerSigner.headers(query, body, khronos);
    const headers = {
        'User-Agent': 'com.dragon.read',
        'Content-Type': 'application/json; charset=utf-8',
        ...signerHeaders,
    };
    const cookieHeader = ids.cookie || (ids.iid ? `store-region=cn-bj; store-region-src=did; install_id=${ids.iid}` : '');
    if (cookieHeader) headers.Cookie = cookieHeader;
    return { url, body, headers };
}

/**
 * 构造全集目录 GET 同身份请求（参考 hongguoTV ContentRepository.directoryItemsV5 形态）：
 * 官网 player 页 vid_list 混淆（v1_ 不透明标识）后，对站方 App 目录接口
 * `/reading/bookapi/directory/all_items/v/` 拉全量纯数字 item_id。
 * 与 video_tab 同为 /reading/bookapi/ 域 GET + 空 body v5 签名（不重新注册设备），
 * 业务参数 book_id/need_version 按 snake_case 编入 query；UA 复用 video_tab gate 口径。
 * @param {string} bookId - 剧集编号（book_id，即 series_id）
 * @param {{device_id?: string, iid?: string, cdid?: string, cookie?: string}} identity - 注册设备身份（仅取三要素与 Cookie，会话/诊断字段不得进 query）
 * @param {string} [apiBase] - 目录端点（默认阶梯首选域名）
 * @returns {{url: string, headers: Object<string,string>}} 签名后请求（GET，无 body）
 * @throws {Error} v5 签名分支试探未命中时抛出
 */
function directoryItemsRequest(bookId, identity, apiBase = DIRECTORY_APIS[0]) {
    const { device_id = '', iid = '', cdid = '' } = identity || {};
    const values = {
        ...V5_PLAYBACK_QUERY,
        iid: iid || '', cdid: cdid || '', device_id: device_id || '',
        book_id: String(bookId),
        need_version: 'true',
    };
    const { url, headers: signedHeaders } = signPlaybackV5(apiBase, values, null);
    const headers = {
        'User-Agent': V5_VIDEO_TAB_UA, Accept: 'application/json; charset=utf-8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...signedHeaders,
    };
    // 设备 Cookie 与登录态合并口径与 playbackRequestV5/videoTabRequest 一致（同身份同会话）
    const cookieHeader = identity?.cookie || (iid ? `store-region=cn-bj; store-region-src=did; install_id=${iid}` : '');
    const authHeaders = loginState.authHeaders();
    if (cookieHeader || authHeaders.Cookie) {
        headers.Cookie = [cookieHeader, authHeaders.Cookie].filter(Boolean).join('; ');
    }
    return { url, headers };
}

module.exports = { playbackRequestV5, videoTabRequest, directoryItemsRequest, shortplayRequest, V5_PLAYBACK_QUERY, V5_PLAYBACK_UA, V5_VIDEO_TAB_UA, SHORTPLAY_APIS, SHORTPLAY_API, VIDEO_TAB_API, DIRECTORY_APIS };
