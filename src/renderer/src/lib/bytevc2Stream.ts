// SPDX-License-Identifier: GPL-3.0-only
// ByteVC2 渐进式播放（MSE）：服务端 ffmpeg 边转码边输出分片 MP4，渲染层经 MediaSource
// 边收边播，首帧无需等待全集转码完成（对照 demo src/client/js/bytevc2-stream.js 移植）。

/** 转码输出格式：H264 Baseline + AAC（与 bytevc2-transcode.js ffmpeg 输出参数对应） */
const MIME = 'video/mp4; codecs="avc1.42c028, mp4a.40.2"';

/** ByteVC2 渐进播放会话句柄：stop() 中止取流并释放 MediaSource 对象 URL */
export interface Bytevc2Session {
  stop: () => void;
}

/**
 * 当前环境是否支持渐进播放（MediaSource + 分片 MP4 编码 + ReadableStream）。
 * @returns {boolean} 支持返回 true（不支持时调用方直接走 buffered 兜底）
 */
function supported(): boolean {
  return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function' &&
    MediaSource.isTypeSupported(MIME) && typeof ReadableStream !== 'undefined';
}

/**
 * 启动渐进播放会话：video.src 挂 MediaSource，sourceopen 后创建 SourceBuffer，
 * 拉取 mse=stream 转码流逐块 appendBuffer，读完 endOfStream。
 * @param {HTMLVideoElement} video - 目标视频元素（src 会被接管为 blob: URL）
 * @param {string} url - 流端点地址（须带 mse=stream 参数，返回渐进转码分片流）
 * @param {number} duration - 视频时长（秒，来自 409 探测响应，用于 MediaSource.duration）
 * @param {() => void} onError - 会话失败回调（调用方应回退 mse=buffered 缓冲模式）
 * @returns {Bytevc2Session} 会话句柄（换集/卸载时须调用 stop()）
 */
function start(
  video: HTMLVideoElement,
  url: string,
  duration: number,
  onError: () => void,
): Bytevc2Session {
  const controller = new AbortController();
  const media = new MediaSource();
  const objectUrl = URL.createObjectURL(media);
  let stopped = false;
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | null = null;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    controller.abort();
    reader?.cancel().catch(() => {});
    URL.revokeObjectURL(objectUrl);
  }

  video.src = objectUrl;
  const ready = new Promise<void>((resolve, reject) => {
    media.addEventListener('sourceopen', () => resolve(), { once: true });
    controller.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  });

  (async () => {
    await ready;
    const source = media.addSourceBuffer(MIME);
    if (duration > 0) media.duration = duration;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('视频转换流不可用');
    reader = response.body.getReader();
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      // SourceBuffer 串行约束：上一块 append 完成才能 append 下一块
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          source.removeEventListener('updateend', success);
          source.removeEventListener('error', failure);
          controller.signal.removeEventListener('abort', cancelled);
        };
        const success = () => { cleanup(); resolve(); };
        const failure = () => { cleanup(); reject(new Error('视频片段无法解码')); };
        const cancelled = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
        source.addEventListener('updateend', success, { once: true });
        source.addEventListener('error', failure, { once: true });
        controller.signal.addEventListener('abort', cancelled, { once: true });
        try { source.appendBuffer(value); } catch (error) { cleanup(); reject(error); }
      });
    }
    if (!stopped && media.readyState === 'open') media.endOfStream();
  })().catch((error) => {
    if (!stopped) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn('[Bytevc2Stream] 渐进播放失败', error);
      }
      stop();
      onError();
    }
  });

  return { stop };
}

/** ByteVC2 渐进播放工具集 */
export const Bytevc2Stream = { supported, start };
