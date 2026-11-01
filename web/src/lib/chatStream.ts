import { useSyncExternalStore } from 'react';
import type { RealtimeEvent } from '@shared/types';

/**
 * 对话角色（设计师 / 训练师）共用的流式上屏状态。
 *
 * 服务端在生成过程中持续推送 `<前缀>.delta`（截至当前的累计正文）与
 * `<前缀>.reasoning`（截至当前的累计思考文本）事件，均为整段替换而非增量拼接，
 * 不落库；这里用极简 external store 接住，聊天页按会话订阅并渲染流式气泡，
 * 最终消息仍以 `<前缀>.message` 落库为准。
 */
export interface ChatStream {
  sessionId: string;
  text: string;
  reasoning: string;
  at: number;
}

/**
 * 当前轮次的状态文本（`<前缀>.status` 的 detail）：「正在思考」「第 N 轮思考中」
 * 「调用工具 xxx」等。与流式正文分开保存——流式内容在每条消息落库时清空，而状态
 * 要跨整轮回复（含工具执行间隙）保留，供等待气泡与头部状态徽标展示，idle 时清掉。
 */
export interface ChatStatus {
  sessionId: string;
  detail: string;
  at: number;
}

class ChatStreamStore {
  private readonly prefix: string;
  private stream: ChatStream | null = null;
  private status: ChatStatus | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** 处理 `<前缀>.delta` / `<前缀>.reasoning`：整段替换累计文本（同一会话内正文与思考互为对方保留）。 */
  recordStreamEvent(event: RealtimeEvent): void {
    if (!event.sessionId) return;
    if (event.type !== `${this.prefix}.delta` && event.type !== `${this.prefix}.reasoning`) return;
    const text = event.text ?? '';
    const reasoning =
      event.type === `${this.prefix}.reasoning`
        ? text
        : this.stream?.sessionId === event.sessionId
          ? this.stream.reasoning
          : '';
    const content =
      event.type === `${this.prefix}.delta`
        ? text
        : this.stream?.sessionId === event.sessionId
          ? this.stream.text
          : '';
    this.stream = { sessionId: event.sessionId, text: content, reasoning, at: Date.now() };
    this.emit();
  }

  /** 处理 `<前缀>.status`：跨整轮回复保留的轮次状态文本。 */
  recordStatusEvent(event: RealtimeEvent): void {
    if (!event.sessionId) return;
    if (event.type !== `${this.prefix}.status`) return;
    this.status = { sessionId: event.sessionId, detail: event.detail ?? '', at: Date.now() };
    this.emit();
  }

  /** 清掉流式正文（落库消息到达或 idle 时）。 */
  clearStream(sessionId?: string | null): void {
    if (!this.stream) return;
    if (sessionId && this.stream.sessionId !== sessionId) return;
    this.stream = null;
    this.emit();
  }

  clearStatus(sessionId?: string | null): void {
    if (!this.status) return;
    if (sessionId && this.status.sessionId !== sessionId) return;
    this.status = null;
    this.emit();
  }

  /** 切换会话时清掉两个状态。 */
  clear(sessionId?: string | null): void {
    this.clearStream(sessionId);
    this.clearStatus(sessionId);
  }

  private subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 箭头属性：允许调用方解构使用（绑定实例）。 */
  useStream = (sessionId: string | null | undefined): ChatStream | null => {
    return useSyncExternalStore(
      this.subscribe,
      () => (sessionId && this.stream && this.stream.sessionId === sessionId ? this.stream : null),
      () => null,
    );
  };

  /** 订阅当前会话的状态文本（无进行中的回复时为 null）；箭头属性允许解构使用。 */
  useStatus = (sessionId: string | null | undefined): ChatStatus | null => {
    return useSyncExternalStore(
      this.subscribe,
      () => (sessionId && this.status && this.status.sessionId === sessionId ? this.status : null),
      () => null,
    );
  };
}

/** 按事件前缀创建一套对话角色的流式状态（每个角色一个实例）。 */
export function createChatStream(prefix: string): ChatStreamStore {
  return new ChatStreamStore(prefix);
}
