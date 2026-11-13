// SPDX-License-Identifier: GPL-3.0-only
// 短信验证码登录（passport 域）——流程对照 HGTV login-lab（tools/login-lab/hgclient.py，
// GPL-3.0）2026-10-15 对 aid=8662 的实测结论：
// - 发码 /passport/mobile/send_code/v1/（type=1），成功回 mobile_ticket
// - 登录候选端点轮询（validate_code → login/v1 → login/v2 → login_or_register →
//   register → combine_login），query 与 form 双形态各试一遍；成功判据为
//   message=success 且 payload.user_id，或 set-cookie 出现 sessionid
// - 登录态 token 取 payload.x_tt_token 或 sessionid，写入 login-state 持久化
// 每一步的平台原文（message/error_code/description）都会带回或落日志，便于实测排障。
const crypto = require('node:crypto');
const { signedPassportRequest, requestJson } = require('./app-source');
const { peekPlaybackDevice, DEFAULT_PROFILE } = require('./playback-device');
const loginState = require('./login-state');
const logger = require('../services/logger');

/** 登录/注册验证码类型（type=3 是换绑分支、type=0 回 1204，勿改） */
const SMS_TYPE = '1';
/** 登录候选端点（顺序依据 login-lab 实测注释；name 仅用于把每步结果带回排障） */
const LOGIN_CANDIDATES = [
    { name: 'validate_code', path: '/passport/mobile/validate_code/v1/', form: false },
    { name: 'validate_code·form', path: '/passport/mobile/validate_code/v1/', form: true },
    { name: 'login/v1', path: '/passport/mobile/login/v1/', form: false },
    { name: 'login/v1·form', path: '/passport/mobile/login/v1/', form: true },
    { name: 'login/v2', path: '/passport/mobile/login/v2/', form: false },
    { name: 'login_or_register/v1', path: '/passport/mobile/login_or_register/v1/', form: false },
    { name: 'register/v1', path: '/passport/mobile/register/v1/', form: false },
    { name: 'combine_login/v1', path: '/passport/mobile/combine_login/v1/', form: false },
];

/** 本进程兜底设备身份（无已注册播放设备时使用，与 login-lab 的静态设备同思路） */
let ephemeralIdentity = null;

/**
 * 取登录用设备身份：优先已注册播放设备（与播放/搜索同源，不触发注册），
 * 否则生成本进程稳定的临时身份（避免每次请求换设备指纹）。
 * @returns {{device_id: string, iid: string, cdid: string, profile: object}} 设备身份
 */
function getIdentity() {
    const persisted = peekPlaybackDevice();
    if (persisted) return persisted;
    if (!ephemeralIdentity) {
        const localId = () => String(1000000000000000n + BigInt('0x' + crypto.randomBytes(6).toString('hex')));
        ephemeralIdentity = { device_id: localId(), iid: localId(), cdid: crypto.randomUUID(), profile: DEFAULT_PROFILE };
        logger.info('Login', `登录使用临时设备身份 device_id=${ephemeralIdentity.device_id.slice(-4)}`);
    }
    return ephemeralIdentity;
}

/**
 * 归一化手机号：11 位纯数字。
 * @param {unknown} raw - 用户输入的手机号
 * @returns {string} 归一化后的手机号
 * @throws {Error} 非 11 位数字时抛出，文案面向设置页展示
 */
function normalizeMobile(raw) {
    const mobile = String(raw ?? '').trim();
    if (!/^\d{11}$/.test(mobile)) throw Object.assign(new Error('手机号格式不对（要 11 位数字）'), { code: 'LOGIN_INPUT' });
    return mobile;
}

/**
 * 归一化验证码：4~8 位数字（红果登录验证码实测 4 位，放宽到 4~8 容错）。
 * @param {unknown} raw - 用户输入的验证码
 * @returns {string} 归一化后的验证码
 * @throws {Error} 非 4~8 位数字时抛出
 */
function normalizeCode(raw) {
    const code = String(raw ?? '').trim();
    if (!/^\d{4,8}$/.test(code)) throw Object.assign(new Error('验证码要 4~8 位数字'), { code: 'LOGIN_INPUT' });
    return code;
}

/**
 * 从 set-cookie 响应头解析 sessionid（登录兜底判据：cookie 会话也算登录成功）。
 * @param {string|string[]|undefined} setCookie - axios 响应头 set-cookie（数组或字符串）
 * @returns {string} sessionid 值；不存在返回空串
 */
function parseSessionCookie(setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
    for (const item of list) {
        const m = /(?:^|;\s*)sessionid=([^;]+)/.exec(item);
        if (m) return m[1];
    }
    return '';
}

/**
 * 发一次 passport 域签名请求并解析 JSON（捕获响应头用于排障）。
 * @param {string} apiPath - passport 接口路径
 * @param {Object<string,string>} params - 业务参数
 * @param {{form?: boolean}} [options] - form=true 时以 POST + urlencoded 发送
 * @returns {Promise<{data: Object, headers: Object<string,*>}>} 解析后的 JSON 与响应头
 * @throws {Error} 签名失败、网络错误、空响应或非 JSON 响应时抛出（requestJson 错误语义）
 */
async function passportCall(apiPath, params, { form = false } = {}) {
    const signed = signedPassportRequest(apiPath, params, getIdentity(), form);
    return await requestJson(signed.url, {
        method: signed.method,
        headers: signed.headers,
        ...(signed.body ? { data: signed.body } : {}),
        withHeaders: true,
    }, Date.now() + 15000);
}

/**
 * 发送登录验证码（type=1）：成功返回 mobile_ticket 供后续登录使用。
 * @param {unknown} mobile - 用户输入的手机号（11 位数字）
 * @returns {Promise<{mobile: string, mobileTicket: string}>} 手机号与 mobile_ticket（可能为空串）
 * @throws {Error} 手机号格式错误、签名/网络失败或平台拒绝（error_code/description 带回）时抛出
 */
async function sendSmsCode(mobile) {
    const m = normalizeMobile(mobile);
    const { data, headers } = await passportCall('/passport/mobile/send_code/v1/', {
        aid: '8662', mobile: m, type: SMS_TYPE,
        device_platform: 'android', app_name: 'novelread', version_code: '73932',
    });
    const payload = (data && typeof data === 'object' && data.data) || {};
    if (data?.message !== 'success') {
        logger.warn('Login', `发码被拒：${payload.description || '未知原因'} error_code=${payload.error_code ?? '-'} logid=${headers?.['x-tt-logid'] || '-'}`);
        throw Object.assign(new Error(`验证码未发出：${payload.description || '平台未说明原因'}（error_code=${payload.error_code ?? '-'}）`), { code: 'LOGIN_REJECTED' });
    }
    logger.info('Login', `验证码已下发${payload.mobile_ticket ? '（mobile_ticket 已取得）' : '（响应缺 mobile_ticket，登录将以无票据参数尝试）'}`);
    return { mobile: m, mobileTicket: String(payload.mobile_ticket || '') };
}

/**
 * 验证码换登录态：候选端点逐一尝试（query/form 双形态），任一成功即取
 * x_tt_token/sessionid 写入 login-state 持久化并返回；全部失败抛错并附每步平台原文。
 * @param {unknown} mobile - 用户输入的手机号（11 位数字）
 * @param {unknown} code - 用户输入的验证码（4~8 位数字）
 * @param {string} [mobileTicket=''] - 发码响应的 mobile_ticket（缺失时以无票据参数尝试）
 * @returns {Promise<{token: string, savedAt: number, endpoint: string, steps: Object[]}>} 保存后的登录态与尝试轨迹
 * @throws {Error} 输入格式错误、保存失败或全部候选端点未返回登录态（steps 带回每步原文）时抛出
 */
async function loginWithCode(mobile, code, mobileTicket = '') {
    const m = normalizeMobile(mobile);
    const c = normalizeCode(code);
    const ticket = String(mobileTicket ?? '').trim();
    const params = { aid: '8662', mobile: m, code: c, type: SMS_TYPE,
        device_platform: 'android', app_name: 'novelread', version_code: '73932' };
    if (ticket) params.mobile_ticket = ticket;

    const steps = [];
    for (const candidate of LOGIN_CANDIDATES) {
        let data, headers;
        try {
            ({ data, headers } = await passportCall(candidate.path, params, { form: candidate.form }));
        } catch (error) {
            steps.push({ step: candidate.name, error: error.message });
            continue;
        }
        const payload = (data && typeof data === 'object' && data.data) || {};
        const cookieSession = parseSessionCookie(headers?.['set-cookie']);
        steps.push({ step: candidate.name, message: String(data?.message ?? '-'),
            error_code: String(payload.error_code ?? '-'), description: String(payload.description || '') });
        if ((data?.message === 'success' && payload.user_id) || cookieSession) {
            const token = String(payload.x_tt_token || payload.sessionid || cookieSession || '');
            if (!token) {
                steps.push({ step: candidate.name, error: '响应成功但未返回登录态字段' });
                continue;
            }
            const saved = loginState.setToken(token);
            logger.info('Login', `验证码登录成功（端点 ${candidate.name}，user_id=${payload.user_id ?? '-'}，${cookieSession && !payload.x_tt_token ? 'token 来自 sessionid' : 'token 来自 x_tt_token/sessionid 字段'}）`);
            return { token: saved.token, savedAt: saved.savedAt, endpoint: candidate.name, steps };
        }
    }
    logger.warn('Login', `登录未完成：${JSON.stringify(steps)}`);
    throw Object.assign(new Error('登录未完成：全部候选端点均未返回登录态（详见日志中的每步平台原文）'), { code: 'LOGIN_FAILED', steps });
}

module.exports = { sendSmsCode, loginWithCode, SMS_TYPE, LOGIN_CANDIDATES };
