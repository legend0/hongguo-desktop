// SPDX-License-Identifier: GPL-3.0-only
/**
 * 视频流本地 HTTP 端点（包内唯一的 HTTP 面）。
 *
 * <video> 标签必须以 HTTP Range 消费解密流，无法走 IPC，因此把 demo 的
 * /api/stream/:vid 抽出为独立的极小 http 服务（不依赖 Express）。
 * 仅暴露 /stream/:token/:vid 一个路由，其余数据获取一律进程内调用。
 *
 * 鉴权（本地端点防未授权消费）：
 *  - 启动时生成一次随机 token（16 字节 hex），路由必须携带正确 token，否则 403；
 *  - 仅接受 Host 为 127.0.0.1:<port> 的请求（防 DNS rebinding / 远程转发）；
 *  - token 只经 IPC 下发到渲染层拼接流地址，不出现在任何对外接口。
 *
 * @param {Object} options - 启动选项。
 * @param {Object} options.streamService - @hongguo/data-server 的 streamService 单例。
 * @param {number} [options.port=0] - 监听端口，默认随机空闲端口。
 * @returns {Promise<{server: import('node:http').Server, port: number, token: string, close: () => void}>}
 *   就绪后的服务句柄（token 供调用方拼接流 URL）；close() 用于应用退出前关闭监听。
 * @throws {Error} 当端口被占用等 listen 失败场景抛出。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

/** 流路由：/stream/:token/:vid（token = 启动时生成的 32 位 hex） */
const STREAM_ROUTE = /^\/stream\/([0-9a-f]{32})\/(\d{1,30})$/;

/**
 * 创建本地解密流端点。
 * @param {{ streamService: object, port?: number }} options 启动选项（见模块 JSDoc）。
 * @returns {Promise<{server: import('node:http').Server, port: number, token: string, close: () => void}>}
 */
function createStreamServer({ streamService, port = 0 } = {}) {
  // 每次启动随机 token：进程内存活期固定，渲染层经 net:play 拿到拼好的流地址
  const token = crypto.randomBytes(16).toString('hex');
  /** 实际监听地址（listen 成功后赋值；Host 白名单校验用） */
  let addr = null;

  const server = http.createServer((req, res) => {
    let vid = '';
    try {
      // Host 白名单：仅接受本机回环地址 + 本端口（防 DNS rebinding / 代理转发）
      const host = String(req.headers.host || '').toLowerCase();
      if (addr && host === `127.0.0.1:${addr.port}`) {
        const u = new URL(req.url, 'http://127.0.0.1');
        const m = STREAM_ROUTE.exec(u.pathname);
        if (m && m[1] === token) {
          vid = m[2];
          // Express 的 req.query 由 handleStream 消费（refresh/quality 参数），这里等价构造
          req.query = Object.fromEntries(u.searchParams);
        }
      }
    } catch {
      // URL 解析失败按 404 处理
    }
    if (!vid) {
      // token 不匹配/缺失 → 403；路由不存在 → 404
      const badToken = /^\/stream\//.test(String(req.url));
      res.writeHead(badToken ? 403 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: badToken ? '无权访问' : '接口不存在' }));
      return;
    }
    streamService.handleStream(req, res, vid);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      addr = server.address();
      resolve({
        server,
        port: addr.port,
        token,
        close: () => server.close(),
      });
    });
  });
}

module.exports = createStreamServer;
