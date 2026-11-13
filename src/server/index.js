// SPDX-License-Identifier: GPL-3.0-only
/**
 * @hongguo/data-server 包入口。
 *
 * 分层（移植自 demo 红果开源播放器 src/server）：
 *  - services/ 服务编排层：双源降级、session/cursor、本地持久化、流媒体调度
 *  - native/    协议实现层：官网 Web 源 + App 端签名协议（匿名设备、SM3 弹幕、CENC 解密）
 *
 * 约定：
 *  - 数据目录通过环境变量 HONGGUO_DATA_DIR 指定（storeService/logger 读取），
 *    必须在 require 本包之前设置。
 *  - 视频流为唯一 HTTP 面：createStreamServer() 提供本地解密流端点，
 *    其余数据获取均为纯异步函数，直接进程内调用。
 */
const dramaService = require('./services/dramaService');
const streamService = require('./services/streamService');
const storeService = require('./services/storeService');
const logger = require('./services/logger');
const danmaku = require('./native/danmaku');
const loginState = require('./native/login-state');
const login = require('./native/login');
const createStreamServer = require('./stream-server');

module.exports = { dramaService, streamService, storeService, logger, danmaku, loginState, login, createStreamServer };
