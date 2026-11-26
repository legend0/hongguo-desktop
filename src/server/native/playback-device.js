// SPDX-License-Identifier: GPL-3.0-only
// ttEncrypt and registration fields adapted from tsukiyo-zero/hongguoTV,
// commit 388931852ddc614db8b00775a3dc54c5ede6307f,
// kotlin-tv/core/src/main/kotlin/com/hongguotv/core/DeviceRegister.kt
// (itself adapted from charlie901208/HGTV feat/phone-login, GPL-3.0-only).
// Changes: anonymous phone profile pool (multi-brand hardware fingerprints,
// one profile picked per registration and persisted with the identity) +
// identity persisted to the local data dir (HONGGUO_DATA_DIR/dev-identity.json)
// with registration/reset cooldowns, so one registration is shared across
// restarts and risk-control cannot be hammered into blocking the IP by
// frequent new-device registrations.
// PR#92 加固（对照 demo 参考项目）：内置已验证基准设备（verified baseline）——
// 无持久化身份时直接复用基准设备而非强制注册；注册时捕获 set-cookie 并随
// 身份持久化；支持 fallbackToDefault 主备通道均受阻时回退基准设备。
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const logger = require('../services/logger');
const { createJar, applyCookies, cookieInfo, cookieState, deviceKey, PLAYBACK_URL } = require('./device-session');

const REGISTER_URL = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
const KDF_SALT = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');

/** 已验证基准播放设备（verified baseline，对照 demo PR#92）：实测可正常取址的
 *  设备身份；无本地持久化身份时优先复用它，避免频繁注册触发风控 */
const DEFAULT_VERIFIED_DEVICE = Object.freeze({
    device_id: '1624456208323876',
    iid: '1624456208327972',
    cdid: '91d56f7e-c027-4ce9-9a3c-229d59a13c3b',
    cookie: 'install_id=1624456208327972; store-region=cn-bj; store-region-src=did',
    created_at: 1794307248831,
});

/**
 * 清洗设备 Cookie 串：去除 ttreq 等易变项；空串时按 install_id 生成兜底 Cookie。
 * @param {string} cookieStr - 原始 Cookie 串（可为空）
 * @param {string} fallbackIid - 兜底 install_id
 * @returns {string} 清洗后的 Cookie 串（可能为空）
 */
function sanitizeCookie(cookieStr, fallbackIid) {
    if (typeof cookieStr !== 'string' || !cookieStr.trim()) {
        return fallbackIid ? `store-region=cn-bj; store-region-src=did; install_id=${fallbackIid}` : '';
    }
    const clean = cookieStr
        .split(';')
        .map(c => c.trim())
        .filter(c => Boolean(c) && !c.toLowerCase().startsWith('ttreq='))
        .join('; ');
    return clean || (fallbackIid ? `store-region=cn-bj; store-region-src=did; install_id=${fallbackIid}` : '');
}

/**
 * 真机硬件指纹池（对照参考架构文档 §3.2）：注册时随机选取一款机型，
 * 注册参数、UA 与后续播放/搜索/弹幕请求的设备参数均使用同一档案，
 * 避免所有用户共用单一固定机型指纹被机型级风控锁定。
 * 字段说明：model=设备型号, brand=品牌, company=厂商(签名 proto 用),
 * osVersion/osApi=安卓版本与 API level, width/height/dpi=分辨率与密度,
 * romVersion=ROM 构建指纹, uaBuild=UA 中的 Build 号。
 */
const DEVICE_PROFILES = [
    { model: '25053RT47C', brand: 'Redmi', company: 'Xiaomi', osVersion: '16', osApi: 36, width: 1280, height: 2772, dpi: 520, romVersion: 'W528JS release-keys', uaBuild: 'BP2A.250605.031.A3' },
    { model: 'PD2309A', brand: 'vivo', company: 'vivo', osVersion: '15', osApi: 35, width: 1260, height: 2800, dpi: 480, romVersion: 'PD2309A_A_15.0.2.0', uaBuild: 'UP1A.231005.007' },
    { model: '23127PN0CC', brand: 'Xiaomi', company: 'Xiaomi', osVersion: '15', osApi: 35, width: 1200, height: 2670, dpi: 480, romVersion: 'OS1.0.5.0.UNCCNXM', uaBuild: 'UKQ1.231003.002' },
    { model: 'PHZ110', brand: 'OPPO', company: 'OPPO', osVersion: '15', osApi: 35, width: 1264, height: 2780, dpi: 480, romVersion: 'PHZ110_15.0.1.000(CN01)', uaBuild: 'UP1A.231005.007' },
    { model: 'BVL-AN10', brand: 'HONOR', company: 'HONOR', osVersion: '15', osApi: 35, width: 1280, height: 2800, dpi: 480, romVersion: 'BVL-AN10 9.1.0.0(C460E1R1P3)', uaBuild: 'UP1A.231005.010' },
    { model: 'ALN-AL10', brand: 'HUAWEI', company: 'HUAWEI', osVersion: '14', osApi: 34, width: 1260, height: 2720, dpi: 480, romVersion: 'ALN-AL10 4.2.0.120(C460E1R1P3)', uaBuild: 'ALN-AL10 4.2.0.120(C460E1R1P3)' },
    { model: 'PJD110', brand: 'OnePlus', company: 'OnePlus', osVersion: '15', osApi: 35, width: 1440, height: 3168, dpi: 560, romVersion: 'OPLUS_PJD110_15.0.0.1', uaBuild: 'UKQ1.230924.001' },
];

/** 默认机型档案（历史持久化身份无档案、或档案非法时的兜底，保持与旧版一致的 Redmi） */
const DEFAULT_PROFILE = DEVICE_PROFILES[0];

/** 设备健康度（last_play_ok）跨进程有效时长：24h 内成功过即视为已验证设备 */
const PROVEN_GOOD_TTL_MS = 24 * 60 * 60 * 1000;
/** markDeviceGood 写盘节流间隔（取址成功较频繁，避免每次都读写文件） */
const MARK_GOOD_THROTTLE_MS = 60 * 60 * 1000;
let lastMarkGoodAt = 0;

/**
 * 记录"当前设备取址成功"时间戳到持久化文件（节流：每进程每小时最多写一次）。
 * 供 app-source 取址成功后调用，使下次进程重启复用设备时享受健康度护栏。
 */
function markDeviceGood() {
    if (Date.now() - lastMarkGoodAt < MARK_GOOD_THROTTLE_MS) return;
    try {
        const file = identityFilePath();
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        saved.last_play_ok = Date.now();
        fs.writeFileSync(file, JSON.stringify(saved, null, 2), 'utf8');
        persistedCache = { value: undefined, loaded: false }; // 健康度已变，失效缓存（任务 87）
        lastMarkGoodAt = Date.now();
    } catch (error) {
        logger.warn('PlaybackDevice', `设备健康度时间戳写入失败: ${error.message}`);
    }
}

/**
 * 校验并归一化机型档案对象（来自持久化文件或内存）；非法时返回 null。
 * @param {unknown} profile - 待校验的档案对象
 * @returns {object|null} 合法的只读档案对象，非法返回 null
 */
function normalizeProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const model = typeof profile.model === 'string' && /^[\w.+-]{2,40}$/i.test(profile.model) ? profile.model : '';
    const brand = typeof profile.brand === 'string' && /^[\w.+-]{2,20}$/i.test(profile.brand) ? profile.brand : '';
    const osVersion = typeof profile.osVersion === 'string' && /^\d{1,2}(\.\d+)?$/.test(profile.osVersion) ? profile.osVersion : '';
    const osApi = Number.isInteger(profile.osApi) && profile.osApi > 0 ? profile.osApi : 0;
    const width = Number.isInteger(profile.width) && profile.width > 0 ? profile.width : 0;
    const height = Number.isInteger(profile.height) && profile.height > 0 ? profile.height : 0;
    const dpi = Number.isInteger(profile.dpi) && profile.dpi > 0 ? profile.dpi : 0;
    if (!model || !brand || !osVersion || !osApi || !width || !height || !dpi) return null;
    return Object.freeze({
        model, brand,
        company: typeof profile.company === 'string' && profile.company ? profile.company : brand,
        osVersion, osApi, width, height, dpi,
        romVersion: typeof profile.romVersion === 'string' && profile.romVersion ? profile.romVersion : DEFAULT_PROFILE.romVersion,
        uaBuild: typeof profile.uaBuild === 'string' && profile.uaBuild ? profile.uaBuild : DEFAULT_PROFILE.uaBuild,
    });
}

/** 从指纹池随机选取一款机型档案（注册新设备时调用） */
function pickRandomProfile() {
    return Object.freeze(DEVICE_PROFILES[Math.floor(Math.random() * DEVICE_PROFILES.length)]);
}

/** 注册失败后的快速失败冷却窗口（期间不再请求注册接口，防止触发风控） */
const REG_FAIL_COOLDOWN_MS = 30 * 1000;
/** 设备重置（丢弃旧设备换新注册）的最小间隔；冷却内沿用当前设备重试。
 *  空响应已实证为 IP 级风控窗口（换设备同样失败），换设备仅作为最后手段，
 *  冷却窗口从 5 分钟提高到 30 分钟，避免窗口期内连环注册触发频率风控。 */
const RESET_COOLDOWN_MS = 30 * 60 * 1000;

/** 播放设备凭据文件路径（与 storeService/logger 同源的数据目录约定；兜底写系统临时目录，避免写进仓库/安装目录） */
function identityFilePath() {
    const dataDir = process.env.HONGGUO_DATA_DIR || path.join(os.tmpdir(), 'hongguo-data');
    return path.join(dataDir, 'dev-identity.json');
}

/** 持久化设备内存缓存（任务 87）：currentProfile/currentProvenGood 等同步接口
 *  位于取址/弹幕热路径，避免每次调用都同步读盘；写盘/清除时同步刷新。
 *  设备文件仅本进程写，无外部失效场景。 */
let persistedCache = { value: undefined, loaded: false };

/** 从本地文件加载持久化播放设备；无效/缺失返回 null。
 *  last_play_ok 在 24h 内 → provenGood=true（跨进程设备健康度护栏：重启后
 *  复用该设备时空响应不再换设备烧注册配额，见 app-source 取址阶梯）。
 *  cookie_jar/session（设备会话，demo 重构新增）随身份一并恢复；旧格式文件自动兼容。 */
function loadPersistedDevice() {
    if (persistedCache.loaded) return persistedCache.value;
    persistedCache.loaded = true;
    try {
        const saved = JSON.parse(fs.readFileSync(identityFilePath(), 'utf8'));
        const device_id = responseId(saved, 'device_id');
        const iid = responseId(saved, 'install_id');
        const cdid = typeof saved?.cdid === 'string' && /^[0-9a-f-]{36}$/i.test(saved.cdid) ? saved.cdid : '';
        if (device_id && iid && cdid) {
            const provenGood = Number(saved?.last_play_ok) > Date.now() - PROVEN_GOOD_TTL_MS;
            persistedCache.value = Object.freeze({
                device_id, iid, cdid,
                cookie: sanitizeCookie(saved.cookie, iid),
                profile: normalizeProfile(saved.profile) || DEFAULT_PROFILE, provenGood,
                created_at: Number(saved?.created_at) || Date.now(),
                cookie_jar: saved?.cookie_jar,
                session: saved?.session && typeof saved.session === 'object' ? saved.session : {},
            });
        }
    } catch {
        /* 无文件或损坏 → 视为未持久化 */
    }
    return persistedCache.value;
}

/** 设备池容量上限（参考 zfdang #108）：保留最近轮换下来的历史设备（含完整会话） */
const DEVICE_POOL_LIMIT = 6;

/**
 * 校验并归一化设备池条目（来自持久化文件）；无效条目返回 null。
 * 池内历史设备携带完整会话（cookie_jar/统计），切换时无损恢复；
 * 机型档案缺失或非法时回退默认档案。
 * @param {unknown} entry - 待校验的池条目
 * @returns {object|null} 合法的只读设备对象，非法返回 null
 */
function parsePoolEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.device_id !== 'string' || !/^\d{10,30}$/.test(entry.device_id)) return null;
    if (typeof entry.iid !== 'string' && !/^\d{10,30}$/.test(String(entry.iid ?? ''))) return null;
    const iid = String(entry.iid ?? '');
    if (!/^\d{10,30}$/.test(iid) || !entry.cdid) return null;
    return Object.freeze({
        device_id: entry.device_id, iid,
        cdid: String(entry.cdid),
        cookie: sanitizeCookie(entry.cookie, iid),
        profile: normalizeProfile(entry.profile) || DEFAULT_PROFILE,
        created_at: Number(entry.created_at) || Date.now(),
        cookie_jar: entry.cookie_jar,
        session: entry.session && typeof entry.session === 'object' ? entry.session : {},
    });
}

/** 从本地文件读取设备池（无效/缺失返回空数组；旧格式文件无 pool 字段自动兼容） */
function loadPersistedPool() {
    try {
        const saved = JSON.parse(fs.readFileSync(identityFilePath(), 'utf8'));
        return Array.isArray(saved?.pool) ? saved.pool.map(parsePoolEntry).filter(Boolean) : [];
    } catch {
        return [];
    }
}

/**
 * 将注册成功的设备凭据写入本地文件（同一设备保留 last_play_ok 健康度；失败仅记录警告，不阻断播放）。
 * demo 重构加固：临时文件 + rename 原子写，避免半写文件损坏身份；会话（cookie_jar/session）随身份落盘。
 * @param {Object} device - 设备身份（device_id/iid/cdid/cookie/profile/cookie_jar/session/created_at）
 * @param {boolean} [strict=false] - true 时写盘失败向外抛出（设备轮换场景要求落盘成功）
 * @param {Array} [pool=[]] - 设备池快照（历史轮换设备，随身份一并落盘）
 * @throws {Error} strict=true 且写盘失败时抛出原始错误
 */
function persistDevice(device, strict = false, pool = []) {
    try {
        fs.mkdirSync(path.dirname(identityFilePath()), { recursive: true });
        // 同一设备重复落盘时保留既有健康度时间戳（换设备则不保留，健康度属于设备而非主机）
        let lastPlayOk;
        try {
            const saved = JSON.parse(fs.readFileSync(identityFilePath(), 'utf8'));
            if (saved?.device_id === device.device_id) lastPlayOk = saved.last_play_ok;
        } catch { /* 无旧文件 */ }
        const payload = JSON.stringify({
            device_id: device.device_id, install_id: device.iid, cdid: device.cdid,
            cookie: device.cookie || '',
            profile: device.profile || DEFAULT_PROFILE,
            created_at: Number(device.created_at) || Date.now(),
            ...(device.cookie_jar ? { cookie_jar: device.cookie_jar } : {}),
            ...(device.session && typeof device.session === 'object' ? { session: device.session } : {}),
            ...(lastPlayOk ? { last_play_ok: lastPlayOk } : {}),
            ...(Array.isArray(pool) && pool.length ? { pool } : {}),
        }, null, 2);
        const tmpPath = `${identityFilePath()}.tmp.${Date.now()}`;
        fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmpPath, identityFilePath());
        persistedCache = { value: undefined, loaded: false }; // 失效缓存，下次读取重建
        logger.info('PlaybackDevice', `播放设备凭据已持久化: ${identityFilePath()}`);
    } catch (error) {
        logger.warn('PlaybackDevice', `播放设备凭据持久化失败: ${error.message}`);
        if (strict) throw error;
    }
}

/** 删除持久化凭据文件（设备重置时调用） */
function clearPersistedDevice() {
    try { fs.rmSync(identityFilePath(), { force: true }); } catch { /* 忽略 */ }
    persistedCache = { value: undefined, loaded: true }; // 已清除，缓存空值（任务 87）
}

function responseId(response, name) {
    const preferred = response?.[`${name}_str`];
    const value = preferred === undefined || preferred === null || preferred === '' ? response?.[name] : preferred;
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    return typeof value === 'string' && /^\d{1,30}$/.test(value) && /[1-9]/.test(value) ? value : '';
}

function createRegistrationRequest(profile = DEFAULT_PROFILE) {
    const now = Date.now();
    const cdid = crypto.randomUUID();
    const header = {
        display_name: '红果免费短剧', update_version_code: 74332, manifest_version_code: 74332,
        app_version_minor: '7.4.3.32', aid: 8662, channel: 'update_64', package: 'com.phoenix.read',
        app_version: '7.4.3.32', version_code: 74332, sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo',
        sdk_target_version: 29, git_hash: '3a88f4e', os: 'Android', os_version: profile.osVersion, os_api: profile.osApi,
        device_model: profile.model, device_brand: profile.brand, device_manufacturer: profile.brand,
        cpu_abi: 'arm64-v8a', release_build: 'b5e187f', density_dpi: profile.dpi, display_density: 'mdpi',
        resolution: `${profile.width}x${profile.height}`, language: 'zh', timezone: 8, access: 'wifi', not_request_sender: 0,
        carrier: 'CHINA MOBILE', mcc_mnc: '46000', rom: 'eng.root.20231116.160340',
        rom_version: profile.romVersion, cdid,
        sig_hash: '56a962410c494bbaf0b58dba20cae56f', openudid: crypto.randomBytes(8).toString('hex'),
        clientudid: crypto.randomUUID(), ipv6_list: [], region: 'CN', tz_name: 'Asia/Shanghai',
        tz_offset: 28800, sim_region: 'cn', sim_serial_number: [], oaid_may_support: false,
        req_id: crypto.randomUUID(), device_platform: 'android',
        custom: { account_region_src: 'fallback', account_region: 'cn', host_bit: 64, dragon_device_type: 'phone' }, pre_installed_channel: '',
        apk_first_install_time: now, is_system_app: 0, sdk_flavor: 'china', guest_mode: 0,
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify({ magic_tag: 'ss_app_log', header, _gen_time: now })));
    const random = crypto.randomBytes(32);
    const derived = crypto.createHash('sha512').update(Buffer.concat([
        crypto.createHash('sha512').update(random).digest(), KDF_SALT,
    ])).digest();
    const cipher = crypto.createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
    const plaintext = Buffer.concat([crypto.createHash('sha512').update(compressed).digest(), compressed]);
    const data = Buffer.concat([Buffer.from('746305100000', 'hex'), random, cipher.update(plaintext), cipher.final()]);
    const options = {
        method: 'POST',
        headers: {
            // UA 版本号与 body version_code 保持一致（74332），机型与 Build 号取当前档案；
            // 播放域请求走 Cronet 网络库，注册 UA 附 Cronet 后缀（对照 demo PR#92）
            'User-Agent': `com.phoenix.read/74332 (Linux; U; Android ${profile.osVersion}; zh_CN; ${profile.model}; Build/${profile.uaBuild}; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)`,
            Accept: 'application/json', 'Content-Type': 'application/octet-stream;tt-data=a',
            'log-encode-type': 'gzip', 'x-ss-dp': '8662', 'x-ss-req-ticket': String(now),
            'x-vc-bdturing-sdk-version': '4.0.3.cn', lc: '101', 'sdk-version': '2',
            'passport-sdk-version': '5051452', 'x-neptune': '-8|50:51:59:30:40:47:49:39',
            'x-ss-stub': crypto.createHash('md5').update(data).digest('hex').toUpperCase(),
        },
        data,
    };
    return { options, cdid };
}

function retryable(error) {
    return error.status === 429 || error.status >= 500 || [
        'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET',
        'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_CANCELED',
        'ERR_NETWORK', 'EMPTY_RESPONSE', 'INVALID_RESPONSE', 'INVALID_REGISTRATION',
    ].includes(error.code);
}

// Cancel only this caller's wait; registration may still be shared by other requests.
function waitForRegistration(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

/**
 * 创建播放设备注册器（单例）。
 * @param {{persist?: boolean}} [options] - persist=false 时禁用持久化与基准设备（测试用）
 * @returns {Function} 注册器函数（附带 reset/fallbackToDefault/currentProfile 等方法）
 */
function createPlaybackDeviceRegistrar(options = {}) {
    /** 是否启用持久化与基准设备（默认生产开启，NODE_ENV=test 关闭） */
    const persist = options.persist ?? (process.env.NODE_ENV !== 'test');
    let registration;
    let request;
    let currentDevice;
    /** 会话 CookieJar（demo 重构新增）：懒创建，随身份/响应持续维护 */
    let jar;
    /** 设备池（参考 zfdang #108）：历史轮换设备（含完整会话），被风控时优先切换而非重新注册 */
    let devicePool = [];
    /** 设备轮换 promise（rotateDevice 进行中标记，并发轮换共享） */
    let rotation;
    /** 会话落盘节流时间戳 */
    let lastSavedAt = 0;
    /** 上次注册失败时间（快速失败冷却） */
    let lastRegFailAt = 0;
    /** 上次设备重置时间（重置冷却） */
    let lastResetAt = 0;
    /** 待保存设备是否与当前设备一致（旧响应不得覆盖新设备会话） */
    const sameDevice = device => Boolean(device && currentDevice
        && device.device_id === currentDevice.device_id && device.iid === currentDevice.iid && device.cdid === currentDevice.cdid);
    const sessionJar = () => jar ||= createJar(currentDevice);
    /**
     * 会话变更落盘（30s 节流；cookie 修剪/更新/失败响应时立即强制写入）。
     * @param {boolean} [force=false] - 跳过节流立即写盘
     * @returns {void}
     */
    const saveSession = (force = false) => {
        if (persist && currentDevice && (force || Date.now() - lastSavedAt >= 30000)) {
            persistDevice(currentDevice, false, devicePool);
            lastSavedAt = Date.now();
        }
    };
    const registrar = function getPlaybackDevice(requestJson, signal) {
        if (signal?.aborted) return Promise.reject(signal.reason);
        // 同步复用路径（demo 重构）：内存设备直接返回；持久化独立设备复用；
        // 持久化为基准设备时不再直接复用，而是触发注册迁移升级为独立设备
        // （demo 上游策略：基准设备仅作为注册失败/换新失败时的保底，不再作为首选身份）
        if (currentDevice) return Promise.resolve(currentDevice);
        if (persist) {
            const loaded = loadPersistedDevice();
            devicePool = loadPersistedPool();
            if (loaded && loaded.device_id !== DEFAULT_VERIFIED_DEVICE.device_id) {
                currentDevice = loaded;
                logger.info('PlaybackDevice', `复用播放设备: device_id=${loaded.device_id}, iid=${loaded.iid}`);
                return Promise.resolve(currentDevice);
            }
            if (loaded && loaded.device_id === DEFAULT_VERIFIED_DEVICE.device_id) {
                logger.info('PlaybackDevice', `检测到本地使用基准静态设备 (device_id=${loaded.device_id})，准备自动迁移为独立注册设备...`);
            }
        }
        if (rotation) return waitForRegistration(rotation, signal);
        // Concurrent playback/search requests share registration. Retries reuse the
        // same encrypted payload and identity, including after an exhausted attempt.
        registration ||= Promise.resolve().then(async () => {
            // 1) 注册失败冷却期内快速失败，不再请求注册接口
            if (Date.now() - lastRegFailAt < REG_FAIL_COOLDOWN_MS) {
                const wait = Math.ceil((REG_FAIL_COOLDOWN_MS - (Date.now() - lastRegFailAt)) / 1000);
                throw Object.assign(new Error(`设备注册冷却中，请 ${wait}s 后重试`), { code: 'RATE_LIMITED' });
            }
            // 2) 每次注册从真机指纹池随机选一款机型（同一设备的所有后续请求使用同一档案）
            const profile = pickRandomProfile();
            request ||= createRegistrationRequest(profile);
            logger.info('PlaybackDevice', `开始匿名设备注册, cdid=${request.cdid}, model=${profile.model}`);
            const deadline = Date.now() + 8000;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const budget = deadline - Date.now();
                    if (budget <= 0) throw Object.assign(new Error('Registration timed out'), { code: 'ETIMEDOUT' });
                    const response = await requestJson(REGISTER_URL, request.options,
                        Date.now() + budget, AbortSignal.timeout(budget));
                    if (Number(response?.code ?? response?.Code ?? 0) !== 0) {
                        throw Object.assign(new Error('Registration rejected'), { code: 'REGISTRATION_REJECTED' });
                    }
                    const device_id = responseId(response, 'device_id');
                    const iid = responseId(response, 'install_id');
                    if (!device_id || !iid) throw Object.assign(new Error('Invalid registration'), { code: 'INVALID_REGISTRATION' });
                    // 捕获注册响应 set-cookie（store-region 等），随身份持久化并在播放请求中回带
                    const respHeaders = response?._headers || response?.headers;
                    const rawCookies = respHeaders?.['set-cookie'];
                    let cookie;
                    if (Array.isArray(rawCookies)) {
                        cookie = sanitizeCookie(rawCookies.map(c => String(c).split(';')[0].trim()).join('; '), iid);
                    } else if (typeof rawCookies === 'string') {
                        cookie = sanitizeCookie(rawCookies.split(';')[0].trim(), iid);
                    } else {
                        cookie = `store-region=cn-bj; store-region-src=did; install_id=${iid}`;
                    }
                    logger.info('PlaybackDevice', `匿名设备注册成功: device_id=${device_id}, iid=${iid}, model=${profile.model}`);
                    const device = Object.freeze({ device_id, iid, cdid: request.cdid, cookie, profile, provenGood: false, created_at: Date.now() });
                    // 注册响应 set-cookie 灌入会话 Jar（demo 重构）：store-region 等身份会话
                    // 由 Jar 按 domain/path/expiry 权威管理，随身份持久化并在后续请求回带
                    const initialJar = createJar(device);
                    applyCookies(initialJar, REGISTER_URL, respHeaders);
                    jar = initialJar;
                    currentDevice = Object.freeze({ ...device, cookie_jar: jar.serializeSync(), session: { cookie_updated_at: Date.now() } });
                    if (persist) {
                        persistDevice(currentDevice, false, devicePool);
                    }
                    // 触发注册成功钩子（行为预热）：尽力而为，不阻塞、不抛错
                    if (typeof registrationHook === 'function') {
                        try { Promise.resolve(registrationHook(currentDevice)).catch(() => { }); } catch { /* 钩子异常不影响播放 */ }
                    }
                    return currentDevice;
                } catch (error) {
                    if (attempt === 2 || !retryable(error) || Date.now() >= deadline) throw error;
                    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
                }
            }
        }).catch(error => {
            registration = undefined;
            if (error.code !== 'RATE_LIMITED') lastRegFailAt = Date.now();
            const reason = error.status ? `HTTP ${error.status}` : error.code || 'INVALID_RESPONSE';
            logger.error('PlaybackDevice', `匿名设备注册失败: ${reason}`);
            // demo 新增：注册失败降级基准设备保底（正式环境），保证弱网/注册接口受阻时仍可播放
            if (options.fallback !== false && process.env.NODE_ENV !== 'test') {
                logger.warn('PlaybackDevice', `注册失败，自动降级使用基准播放设备保底: device_id=${DEFAULT_VERIFIED_DEVICE.device_id}`);
                currentDevice = DEFAULT_VERIFIED_DEVICE;
                jar = undefined;
                return currentDevice;
            }
            throw Object.assign(new Error(`匿名播放设备注册失败（${reason}），请稍后重试`), {
                code: 'DEVICE_REGISTRATION_FAILED', cause: error,
            });
        });
        return waitForRegistration(registration, signal);
    };
    /** 同步读取当前活跃设备（内存优先，持久化兜底；不触发注册。
     *  demo 重构语义：含基准设备——元数据等旁路请求与播放设备始终同源，
     *  基准设备保底期间旁路请求同样使用基准身份，保证设备参数一致性） */
    registrar.getCurrentDevice = function getCurrentDevice() {
        if (currentDevice) return currentDevice;
        if (persist) {
            const loaded = loadPersistedDevice();
            devicePool = devicePool.length ? devicePool : loadPersistedPool();
            if (loaded && loaded.device_id !== DEFAULT_VERIFIED_DEVICE.device_id) {
                currentDevice = loaded;
                return currentDevice;
            }
        }
        return null;
    };
    /**
     * 按 URL 上的 device_id/iid/cdid query 匹配当前设备（demo 重构）。
     * 请求开始时捕获代次：旧设备的迟到响应绝不允许覆盖替换后设备的身份或 Cookie。
     * @param {string} url - 含签名 query 的完整请求 URL
     * @returns {Object|null} 匹配的设备身份；不匹配返回 null
     */
    registrar.matchRequest = function matchRequest(url) {
        const query = new URL(url).searchParams;
        const device = registrar.getCurrentDevice();
        return device && query.get('device_id') === device.device_id && query.get('iid') === device.iid
            && (!query.has('cdid') || query.get('cdid') === device.cdid) ? device : null;
    };
    /**
     * 请求开始：记录会话使用统计并返回作用域 Cookie（demo 重构）。
     * 读取会顺带修剪过期 cookie；修剪发生时立即落盘。
     * @param {Object} device - matchRequest 返回的设备身份
     * @param {string} url - 本次请求 URL（cookie 作用域）
     * @returns {{cookie: string, idle_before_request_ms: number|null, device_key: string, cookie_names: string[], cookie_count: number}|null} 会话快照；设备不匹配返回 null
     */
    registrar.beginRequest = function beginRequest(device, url) {
        if (!sameDevice(device)) return null;
        const now = Date.now();
        const idle = currentDevice.session?.last_used_at ? Math.max(0, now - currentDevice.session.last_used_at) : null;
        const before = cookieState(sessionJar());
        const cookie = sessionJar().getCookieStringSync(url);
        const pruned = before !== cookieState(sessionJar());
        currentDevice = Object.freeze({ ...currentDevice, cookie_jar: sessionJar().serializeSync(),
            session: { ...currentDevice.session, ...(pruned ? { cookie_pruned_at: now } : {}),
                last_used_at: now, request_count: (Number(currentDevice.session?.request_count) || 0) + 1 } });
        saveSession(pruned);
        return { cookie, idle_before_request_ms: idle, ...registrar.diagnostics(device, url) };
    };
    /**
     * 当前设备会话诊断信息（demo 重构）：设备代次/年龄/会话统计/cookie 状态。
     * @param {Object} device - 设备身份
     * @param {string} url - 目标 URL
     * @returns {Object} 诊断字段（设备不匹配时仅含 stale_device: true）
     */
    registrar.diagnostics = function diagnostics(device, url) {
        if (!sameDevice(device)) return { stale_device: true };
        return { device_key: deviceKey(currentDevice), device_age_ms: Math.max(0, Date.now() - (Number(currentDevice.created_at) || Date.now())),
            ...currentDevice.session, ...cookieInfo(sessionJar(), url) };
    };
    /**
     * 响应结束：回写 set-cookie 到会话 Jar 并更新成败统计（demo 重构）。
     * cancelled（客户端主动取消）不计入失败；cookie 变更或失败响应触发落盘。
     * @param {Object} device - matchRequest 返回的设备身份
     * @param {string} url - 响应对应 URL
     * @param {Object} headers - 响应头（取 set-cookie；网络异常时传空对象）
     * @param {string} outcome - 结果码（'ok' / HTTP_x / EMPTY_RESPONSE / ERR_CANCELED 等）
     * @returns {Object} 会话诊断 + set_cookie 处理统计
     */
    registrar.recordResponse = function recordResponse(device, url, headers, outcome) {
        if (!sameDevice(device)) return { stale_device: true };
        const now = Date.now();
        const before = cookieState(sessionJar());
        const update = applyCookies(sessionJar(), url, headers);
        // Reading also prunes expired cookies before persistence.
        sessionJar().getCookieStringSync(url);
        const serialized = sessionJar().serializeSync();
        const changed = before !== cookieState(sessionJar());
        const ok = outcome === 'ok';
        const cancelled = outcome === 'ERR_CANCELED';
        const session = { ...currentDevice.session, last_response_at: now,
            ...(ok ? { last_success_at: now, consecutive_failures: 0, last_error: null }
                : cancelled ? {} : { last_failure_at: now, last_error: outcome,
                    consecutive_failures: (Number(currentDevice.session?.consecutive_failures) || 0) + 1 }),
            ...(changed ? { cookie_updated_at: now } : {}) };
        currentDevice = Object.freeze({ ...currentDevice, session, cookie_jar: serialized,
            cookie: sessionJar().getCookieStringSync(PLAYBACK_URL) });
        saveSession(changed || !ok);
        return { ...registrar.diagnostics(device, url), set_cookie: update, cookie_changed: changed };
    };
    /**
     * 用户主动更换设备（demo 重构新增）：注册全新独立设备并替换当前身份。
     * 先等在途注册完成再替换；候选注册器不落盘（strict 落盘交给主注册器）。
     * @param {Function} requestJson - 请求通道函数
     * @param {AbortSignal} [signal] - 取消信号
     * @returns {Promise<Object>} 新设备身份
     * @throws {Error} 注册失败或落盘失败时抛出
     */
    registrar.rotateDevice = async function rotateDevice(requestJson, signal) {
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (!rotation) {
            rotation = (async () => {
                // Let an earlier registration finish before replacing its result.
                if (registration) await registration.catch(() => {});
                logger.info('PlaybackDevice', '收到用户主动更换设备指令，开始注册全新的独立匿名设备...');
                const candidate = createPlaybackDeviceRegistrar({ persist: false, fallback: false });
                const newDevice = await candidate(requestJson);
                // 换下的旧设备入池保留（参考 zfdang #108）：可能带有成功取流历史，
                // 风控窗口过后是比全新设备可信得多的轮换候选，不直接丢弃
                if (currentDevice && currentDevice.device_id !== DEFAULT_VERIFIED_DEVICE.device_id) {
                    devicePool = [{ ...currentDevice }, ...devicePool.filter(d => d.device_id !== currentDevice.device_id)];
                    while (devicePool.length > DEVICE_POOL_LIMIT) devicePool.pop();
                }
                currentDevice = newDevice;
                jar = undefined;
                registration = undefined;
                request = undefined;
                if (persist) {
                    persistDevice(newDevice, true, devicePool);
                }
                return newDevice;
            })().finally(() => { rotation = undefined; });
        }
        return waitForRegistration(rotation, signal);
    };
    /**
     * 设备池轮换（参考 zfdang #108）：被风控时优先切换到"有成功取流历史"的池内老设备
     * （上游已信任过的身份，cookie/统计随池条目无损恢复），零注册配额消耗；
     * 当前设备（非基准）换下入池保留。无合格候选时返回 null（调用方走全新注册阶梯）。
     * @returns {Object|null} 轮换后的当前设备；池空/无候选时 null
     */
    registrar.rotateToPooledDevice = function rotateToPooledDevice() {
        if (!persist) return null;
        // 仅轮换到历史上成功取过流（last_success_at>0）的设备，按最近成功时间降序选择
        const candidates = devicePool
            .filter(d => Number(d.session?.last_success_at) > 0)
            .sort((a, b) => Number(b.session?.last_success_at) - Number(a.session?.last_success_at));
        if (!candidates.length) return null;
        const pick = candidates[0];
        logger.info('PlaybackDevice',
            `设备池轮换: 换出 device_id=${currentDevice?.device_id ?? '无'}, 切入 device_id=${pick.device_id}（历史成功取流 ${new Date(Number(pick.session.last_success_at)).toISOString()}）`);
        // 当前设备换下入池（基准设备不入池，避免占位）
        if (currentDevice && currentDevice.device_id !== DEFAULT_VERIFIED_DEVICE.device_id) {
            devicePool = [{ ...currentDevice }, ...devicePool.filter(d => d.device_id !== currentDevice.device_id)];
            while (devicePool.length > DEVICE_POOL_LIMIT) devicePool.pop();
        }
        devicePool = devicePool.filter(d => d.device_id !== pick.device_id);
        currentDevice = Object.freeze({ ...pick, cookie_jar: pick.cookie_jar });
        jar = undefined;
        registration = undefined;
        request = undefined;
        persistDevice(currentDevice, false, devicePool);
        return currentDevice;
    };
    /** 主备通道均空响应时的兜底（PR#92）：回退到内置基准设备并持久化；
     *  基准设备为实测可用身份，切换不消耗注册配额、不触发风控。
     *  同时作废会话 Jar（demo 重构）：下次请求按基准设备 cookie 重建。
     *  被换下的当前设备入池保留（参考 zfdang #108），供设备池轮换复用。 */
    registrar.fallbackToDefault = function fallbackToDefault() {
        // 当前独立设备入池（基准设备自身无需入池）
        if (currentDevice && currentDevice.device_id !== DEFAULT_VERIFIED_DEVICE.device_id) {
            devicePool = [{ ...currentDevice }, ...devicePool.filter(d => d.device_id !== currentDevice.device_id)];
            while (devicePool.length > DEVICE_POOL_LIMIT) devicePool.pop();
        }
        currentDevice = DEFAULT_VERIFIED_DEVICE;
        jar = undefined;
        registration = undefined;
        request = undefined;
        if (persist) {
            persistDevice(DEFAULT_VERIFIED_DEVICE, false, devicePool);
        }
        logger.info('PlaybackDevice', `已自动切换并持久化基准播放设备: device_id=${currentDevice.device_id}`);
        return currentDevice;
    };
    registrar.reset = function resetPlaybackDevice(expectedDevice) {
        // A late failure from an old request must not discard a newer registration.
        if (expectedDevice && currentDevice !== expectedDevice) return false;
        // 重置冷却：换新设备会消耗一次注册配额，过于频繁会触发 IP 级风控；
        // 冷却内沿用当前设备重试（空响应往往与服务端瞬时风控相关，未必是设备问题）。
        if (Date.now() - lastResetAt < RESET_COOLDOWN_MS) {
            logger.warn('PlaybackDevice',
                `设备重置冷却中（距上次重置 ${Math.round((Date.now() - lastResetAt) / 1000)}s < ${RESET_COOLDOWN_MS / 1000}s），沿用当前设备重试`);
            return false;
        }
        lastResetAt = Date.now();
        registration = undefined;
        request = undefined;
        currentDevice = undefined;
        jar = undefined;
        clearPersistedDevice();
        return true;
    };
    /** 同步获取当前设备机型档案（内存/持久化文件，不触发注册请求；
     *  供弹幕等需要拼 UA/设备参数但不便等待注册完成的模块使用） */
    registrar.currentProfile = function currentProfile() {
        return currentDevice?.profile || loadPersistedDevice()?.profile || DEFAULT_PROFILE;
    };
    /** 同步查询当前设备是否为"已验证可用"（本进程成功过，或持久化 last_play_ok 在 24h 内）；
     *  供 app-source 空响应阶梯判断是否允许换设备 */
    registrar.currentProvenGood = function currentProvenGood() {
        return currentDevice?.provenGood === true || loadPersistedDevice()?.provenGood === true;
    };
    /** 取址成功后记录设备健康度时间戳（跨进程护栏） */
    registrar.markDeviceGood = function markDeviceGoodForCurrent() {
        if (currentDevice) markDeviceGood();
    };
    return registrar;
}

const getPlaybackDevice = createPlaybackDeviceRegistrar();
// 注册成功钩子：供 app-source 绑定行为预热（新设备只有注册行为会被判采集器特征）
let registrationHook = null;

/**
 * 绑定注册成功后的回调（当前供 app-source 触发行为预热）。
 * @param {((device: {device_id: string, iid: string, cdid: string, profile: object}) => void|Promise<void>) | null} fn - 回调函数，传 null 解绑
 */
function setRegistrationHook(fn) {
    registrationHook = typeof fn === 'function' ? fn : null;
}

/**
 * 读取已持久化的播放设备身份（不触发注册、无副作用）；无持久化凭据返回 null。
 * 供登录域（passport）复用同一设备指纹，避免登录请求另起炉灶或消耗注册配额。
 * @returns {{device_id: string, iid: string, cdid: string, profile: object, provenGood: boolean}|null} 设备身份或 null
 */
function peekPlaybackDevice() {
    return loadPersistedDevice();
}

module.exports = { getPlaybackDevice, createPlaybackDeviceRegistrar, DEFAULT_PROFILE, DEFAULT_VERIFIED_DEVICE, setRegistrationHook, peekPlaybackDevice };
