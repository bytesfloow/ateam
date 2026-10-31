import { useSyncExternalStore } from 'react';
import type { RealtimeEvent } from '@shared/types';

/**
 * 逐回合的「当前活动」心跳。
 *
 * 模型改成流式请求后，服务端会在生成过程中持续推送 `agent.activity` 事件
 * （例如“第 2 轮生成中 · 正文 1200 字”）。这些只是瞬时状态，不落库，
 * 所以在前端用一个极简的 external store 接住，任务卡片按 turnId 订阅。
 */
export interface TurnActivity {
  detail: string;
  at: number;
}

const activities = new Map<string, TurnActivity>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function recordActivity(event: RealtimeEvent): void {
  if (!event.turnId || !event.detail) return;
  activities.set(event.turnId, { detail: event.detail, at: Date.now() });
  emit();
}

/** 回合结束时清掉心跳，避免下次打开还显示旧的生成进度。 */
export function clearActivity(turnId: string | null | undefined): void {
  if (!turnId || !activities.delete(turnId)) return;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTurnActivity(turnId: string | null | undefined): TurnActivity | null {
  return useSyncExternalStore(
    subscribe,
    () => (turnId ? activities.get(turnId) ?? null : null),
    () => null,
  );
}

/** 只保留最近 5 分钟的条目，防止长时间运行后 Map 无限增长。 */
export function pruneActivities(maxAgeMs = 5 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  let changed = false;
  for (const [turnId, activity] of activities) {
    if (activity.at < cutoff) {
      activities.delete(turnId);
      changed = true;
    }
  }
  if (changed) emit();
}
