import type { RealtimeEvent } from '@shared/types';
import { createChatStream } from './chatStream';

/**
 * 智能体训练师对话的流式上屏状态（与设计师共用通用实现，事件前缀 trainer）。
 * 见 chatStream.ts 的机制说明。
 */
const store = createChatStream('trainer');

export type TrainerStream = ReturnType<typeof store.useStream>;
export type TrainerStatus = ReturnType<typeof store.useStatus>;

export function recordTrainerStreamEvent(event: RealtimeEvent): void {
  store.recordStreamEvent(event);
}

export function clearTrainerStream(sessionId?: string | null): void {
  store.clearStream(sessionId);
}

export function recordTrainerStatusEvent(event: RealtimeEvent): void {
  store.recordStatusEvent(event);
}

export function clearTrainerStatus(sessionId?: string | null): void {
  store.clearStatus(sessionId);
}

export function clearTrainerChatState(sessionId?: string | null): void {
  store.clear(sessionId);
}

export function useTrainerStream(sessionId: string | null | undefined) {
  return store.useStream(sessionId);
}

export function useTrainerStatus(sessionId: string | null | undefined) {
  return store.useStatus(sessionId);
}

export const trainerChatStream = store;
