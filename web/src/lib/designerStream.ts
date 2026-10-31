import { useSyncExternalStore } from 'react';
import type { RealtimeEvent } from '@shared/types';

/**
 * 设计师对话的流式上屏状态。
 *
 * 服务端在生成过程中持续推送 `designer.delta`（截至当前的累计正文）与
 * `designer.reasoning`（截至当前的累计思考文本）事件，均为整段替换而非增量拼接，
 * 不落库；这里用极简 external store 接住，DesignerPage 按会话订阅并渲染流式气泡，
 * 最终消息仍以 `designer.message` 落库为准。
 */
export interface DesignerStream {
  sessionId: string;
  text: string;
  reasoning: string;
  at: number;
}

/**
 * 设计师当前轮次的状态文本（designer.status 的 detail）：「正在思考」「第 N 轮思考中」
 * 「调用工具 xxx」等。与流式正文分开保存——流式内容在每条消息落库时清空，而状态
 * 要跨整轮回复（含工具执行间隙）保留，供等待气泡与头部状态徽标展示，idle 时清掉。
 */
export interface DesignerStatus {
  sessionId: string;
  detail: string;
  at: number;
}

let stream: DesignerStream | null = null;
let status: DesignerStatus | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function recordDesignerStreamEvent(event: RealtimeEvent): void {
  if (!event.sessionId) return;
  if (event.type !== 'designer.delta' && event.type !== 'designer.reasoning') return;
  const text = event.text ?? '';
  const reasoning = event.type === 'designer.reasoning' ? text : (stream?.sessionId === event.sessionId ? stream.reasoning : '');
  const content = event.type === 'designer.delta' ? text : (stream?.sessionId === event.sessionId ? stream.text : '');
  const next: DesignerStream = { sessionId: event.sessionId, text: content, reasoning, at: Date.now() };
  if (
    stream &&
    stream.sessionId === next.sessionId &&
    stream.text === next.text &&
    stream.reasoning === next.reasoning
  ) {
    return;
  }
  stream = next;
  emit();
}

/** 消息落库、回复结束或切换会话后清掉流式状态，避免残留旧内容。 */
export function clearDesignerStream(sessionId?: string | null): void {
  if (!stream) return;
  if (sessionId && stream.sessionId !== sessionId) return;
  stream = null;
  emit();
}

/** 记录设计师当前轮次的状态文本；detail 为空或 idle 时视为结束，清掉状态。 */
export function recordDesignerStatusEvent(event: RealtimeEvent): void {
  if (!event.sessionId) return;
  const detail = (event.detail ?? '').trim();
  if (!detail || detail === 'idle') {
    clearDesignerStatus(event.sessionId);
    return;
  }
  if (status && status.sessionId === event.sessionId && status.detail === detail) return;
  status = { sessionId: event.sessionId, detail, at: Date.now() };
  emit();
}

/** 回复结束后清掉状态文本，避免残留。 */
export function clearDesignerStatus(sessionId?: string | null): void {
  if (!status) return;
  if (sessionId && status.sessionId !== sessionId) return;
  status = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDesignerStream(sessionId: string | null | undefined): DesignerStream | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId && stream && stream.sessionId === sessionId ? stream : null),
    () => null,
  );
}

/** 订阅当前会话的设计师状态文本（无进行中的回复时为 null）。 */
export function useDesignerStatus(sessionId: string | null | undefined): DesignerStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId && status && status.sessionId === sessionId ? status : null),
    () => null,
  );
}
