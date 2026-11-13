// 登录态（x-tt-token）管理。
// 依据《播放接口与风控分析》：匿名观看有约 9 集配额上限，登录态是可播性的
// 分水岭，也是唯一可持续路径。第一阶段支持在设置页手动粘贴从官方 App 抓包
// 获得的 x-tt-token（验证码自动登录需实测 passport 接口后再扩展）。
// token 持久化到本地数据目录（与设备凭据同目录），仅本机使用。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const logger = require('../services/logger');

/** x-tt-token 请求头仅取前 56 字符（五项目横向拆解文档 §2.3 实测口径） */
const TOKEN_HEADER_LENGTH = 56;
/** 纯 x-tt-token 值（base64 系，'=' 仅允许结尾 padding） */
const TOKEN_PLAIN_RE = /^[A-Za-z0-9+/_=-]+$/;
/** 整段 Cookie 串字符集（k=v; k=v，sid_guard 含 | 与 GMT 日期含 , : 空格） */
const TOKEN_COOKIE_RE = /^[A-Za-z0-9+/_=;:,|\-\s]+$/;

function tokenFilePath() {
    const dataDir = process.env.HONGGUO_DATA_DIR || path.join(os.tmpdir(), 'hongguo-data');
    return path.join(dataDir, 'login-state.json');
}

/**
 * 判定 token 是否为整段 Cookie 串形态：去掉结尾 base64 padding '=' 后中间仍有 '='
 * （合法 base64 的 '=' 只出现在结尾；Cookie 串的 '=' 在 k=v 中间）。
 * @param {string} token - 归一化后的 token
 * @returns {boolean} true 表示 Cookie 串形态
 */
function isCookieForm(token) {
    return token.replace(/=+$/, '').includes('=');
}

/**
 * 校验用户粘贴的 token 字符串：容忍整段 "x-tt-token: xxx" 复制、引号与空白，
 * 同时放行两种形态——① x-tt-token 值（base64 系）② 整段 Cookie 串（k=v; k=v，
 * 含 '=' 时请求头会双带 Cookie，login-lab 实测更稳）。
 * @param {string} raw - 用户输入的原始 token 文本
 * @returns {string} 归一化后的 token（>56 字符时请求头自行截断）
 * @throws {Error} 输入为空或含非法字符时抛出，文案面向设置页展示
 */
function normalizeToken(raw) {
    let token = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
    token = token.replace(/^x-tt-token\s*[:：]\s*/i, '').trim();
    if (!token) throw new Error('token 不能为空');
    if (isCookieForm(token)) {
        if (!TOKEN_COOKIE_RE.test(token) || !/^[A-Za-z0-9_]+\s*=/.test(token)) {
            throw new Error('Cookie 串含非法字符，请从抓包工具完整复制 Cookie 或 x-tt-token 值');
        }
        if (token.length < 20) throw new Error('Cookie 串长度过短，请确认复制完整');
        return token.replace(/\s*;\s*/g, '; ');
    }
    if (!TOKEN_PLAIN_RE.test(token)) throw new Error('token 含非法字符，请重新从抓包工具完整复制');
    if (token.length < 20) throw new Error('token 长度过短，请确认复制的是完整的 x-tt-token 值');
    return token;
}

/**
 * 读取当前登录态；文件缺失/损坏/字段非法时返回 null（按匿名态运行）。
 * @returns {{token: string, savedAt: number}|null} 登录态对象或 null
 */
function getLoginState() {
    try {
        const saved = JSON.parse(fs.readFileSync(tokenFilePath(), 'utf8'));
        const token = typeof saved?.token === 'string' ? saved.token : '';
        const valid = token.length >= 20 && (TOKEN_PLAIN_RE.test(token) || (isCookieForm(token) && TOKEN_COOKIE_RE.test(token)));
        if (valid) {
            return { token, savedAt: Number(saved?.savedAt) || 0 };
        }
    } catch {
        /* 无文件或损坏 → 按匿名态 */
    }
    return null;
}

/** 当前是否存在有效格式的登录态 */
function hasToken() {
    return getLoginState() !== null;
}

/** 发请求时实际使用的 x-tt-token 头值（前 56 字符）；无登录态返回 null */
function tokenHeader() {
    const state = getLoginState();
    return state ? state.token.slice(0, TOKEN_HEADER_LENGTH) : null;
}

/**
 * 构造登录态请求头：x-tt-token（前 56 字符）恒注入；token 为整段 Cookie 串
 * （含 "="，如 sid_guard 形态）时同时注入 Cookie 头——login-lab 实测 Cookie 头
 * 比 X-Tt-Token 头稳，双带兼容两种服务端识别路径。
 * @returns {Object<string,string>} 登录态请求头；匿名态返回空对象
 */
function authHeaders() {
    const state = getLoginState();
    if (!state) return {};
    const headers = { 'x-tt-token': state.token.slice(0, TOKEN_HEADER_LENGTH) };
    if (isCookieForm(state.token)) headers.Cookie = state.token;
    return headers;
}

/**
 * 保存登录态（覆盖写；失败仅记录警告不抛出，避免设置页崩溃）。
 * @param {string} raw - 用户输入的原始 token 文本
 * @returns {{token: string, savedAt: number}} 保存后的登录态
 */
function setToken(raw) {
    const token = normalizeToken(raw);
    const state = { token, savedAt: Date.now() };
    try {
        fs.mkdirSync(path.dirname(tokenFilePath()), { recursive: true });
        fs.writeFileSync(tokenFilePath(), JSON.stringify(state, null, 2), 'utf8');
        logger.info('LoginState', '登录态 token 已保存（匿名配额限制解除，请求将携带 x-tt-token）');
    } catch (error) {
        logger.warn('LoginState', `登录态保存失败: ${error.message}`);
        throw new Error('登录态保存失败：数据目录不可写');
    }
    return state;
}

/** 清除登录态（恢复匿名运行） */
function clearToken() {
    try {
        fs.rmSync(tokenFilePath(), { force: true });
        logger.info('LoginState', '登录态已清除，恢复匿名态');
    } catch (error) {
        logger.warn('LoginState', `登录态清除失败: ${error.message}`);
    }
}

module.exports = { getLoginState, hasToken, tokenHeader, authHeaders, setToken, clearToken, TOKEN_HEADER_LENGTH };
