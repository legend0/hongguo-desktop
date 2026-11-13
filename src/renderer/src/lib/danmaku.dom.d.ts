/**
 * vendored Danmaku 2.0.10（MIT，见 danmaku.LICENSE）类型声明。
 * 仅覆盖本项目用到的 API 面：构造挂载 / speed / destroy / resize / show / hide / clear。
 */

/** 单条弹幕注释（时间轴秒；media 引擎随视频时间自动上屏/回收） */
export interface DanmakuComment {
  /** 上屏时间（秒） */
  time: number;
  /** 文本内容（与 render 二选一） */
  text?: string;
  /** 滚动/固定模式，缺省 'rtl'（右→左滚动） */
  mode?: 'rtl' | 'ltr' | 'top' | 'bottom';
  /** 自定义渲染节点（可携带点赞角标等富内容） */
  render?: () => HTMLElement;
  /** 节点样式覆盖 */
  style?: Record<string, string>;
  /** 相邻弹幕间距（px），缺省跟随引擎 */
  margin?: number;
  /** 单条速度覆盖（px/s） */
  speed?: number;
}

declare class Danmaku {
  constructor(options: {
    /** 弹幕容器（overflow: hidden 的覆盖层） */
    container: HTMLElement;
    /** 关联媒体元素；提供后引擎跟随其时间轴与播放/暂停 */
    media?: HTMLMediaElement | null;
    /** 初始弹幕列表 */
    comments?: DanmakuComment[];
    /** 全屏滚动速度（px/s），0 走默认值 */
    speed?: number;
  });
  /** 全局滚动速度（px/s），可运行时更新 */
  speed: number;
  /** 销毁引擎并清空容器 */
  destroy(): void;
  /** 容器尺寸变化后重新布局 */
  resize(): void;
  /** 显示弹幕层 */
  show(): void;
  /** 隐藏弹幕层（引擎继续走时间轴） */
  hide(): void;
  /** 清空已上屏弹幕（保留列表） */
  clear(): void;
}

export default Danmaku;
