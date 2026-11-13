import { app } from 'electron';
import { join } from 'path';

/**
 * data-server 启动环境：
 * storeService / logger 在模块加载时即读取数据与日志目录，
 * 因此本模块必须在 import '@hongguo/server' 之前被引入。
 */
if (!process.env.HONGGUO_DATA_DIR) {
  process.env.HONGGUO_DATA_DIR = join(app.getPath('userData'), 'data');
}
if (!process.env.HONGGUO_LOG_DIR) {
  process.env.HONGGUO_LOG_DIR = join(app.getPath('userData'), 'logs');
}
