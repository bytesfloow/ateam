import type { RealtimeEvent } from '@shared/types';
import { createChatStream } from './chatStream';

/**
 * 设计师对话的流式上屏状态（委托给通用实现，事件前缀 designer）。
 * 见 chatStream.ts 的机制说明；导出函数名保持与原版一致。
 */
const store = createChatStream('designer');

export type DesignerStream = ReturnType<typeof store.useStream>;
export type DesignerStatus = ReturnType<typeof store.useStatus>;

export function recordDesignerStreamEvent(event: RealtimeEvent): void {
  store.recordStreamEvent(event);
}

export function clearDesignerStream(sessionId?: string | null): void {
  store.clearStream(sessionId);
}

export function recordDesignerStatusEvent(event: RealtimeEvent): void {
  store.recordStatusEvent(event);
}

export function clearDesignerStatus(sessionId?: string | null): void {
  store.clearStatus(sessionId);
}

export function clearDesignerChatState(sessionId?: string | null): void {
  store.clear(sessionId);
}

export function useDesignerStream(sessionId: string | null | undefined) {
  return store.useStream(sessionId);
}

export function useDesignerStatus(sessionId: string | null | undefined) {
  return store.useStatus(sessionId);
}

export const designerChatStream = store;
