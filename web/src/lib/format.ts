import type {
  FeedbackCategory,
  FeedbackSeverity,
  FeedbackStatus,
  HandoffTargetType,
  TaskStatus,
  TurnStatus,
} from '@shared/types';

export function cn(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatFullDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return '—';
  if (diff < 30_000) return '刚刚';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(iso);
}

export function formatDuration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return '—';
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '—';
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const chars = [...trimmed];
  if (chars.length <= 2) return trimmed;
  return chars.slice(0, 2).join('');
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: Tone }> = {
  running: { label: '执行中', tone: 'accent' },
  paused: { label: '已暂停', tone: 'danger' },
  waiting_human: { label: '等待验收', tone: 'warning' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  aborted: { label: '已终止', tone: 'neutral' },
};

export const TURN_STATUS_META: Record<TurnStatus, { label: string; tone: Tone }> = {
  running: { label: '执行中', tone: 'accent' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  aborted: { label: '已终止', tone: 'neutral' },
};

/** 'end' 是旧版本遗留的交接目标（智能体自行宣布任务结束），仅用于历史数据展示。 */
export const HANDOFF_TARGET_META: Record<HandoffTargetType | 'end', { label: string; tone: Tone }> = {
  agent: { label: '交给下游智能体', tone: 'accent' },
  human: { label: '交给用户验收', tone: 'warning' },
  end: { label: '结束任务', tone: 'success' },
};

export const FEEDBACK_CATEGORY_META: Record<FeedbackCategory, { label: string; tone: Tone }> = {
  prompt: { label: '提示词', tone: 'accent' },
  tool: { label: '工具', tone: 'warning' },
  skill: { label: '技能', tone: 'info' },
  workflow: { label: '流程', tone: 'neutral' },
  agent: { label: '智能体', tone: 'info' },
  environment: { label: '运行环境', tone: 'success' },
  other: { label: '其他', tone: 'neutral' },
};

export const FEEDBACK_SEVERITY_META: Record<FeedbackSeverity, { label: string; tone: Tone }> = {
  low: { label: '低优先级', tone: 'neutral' },
  medium: { label: '中优先级', tone: 'warning' },
  high: { label: '高优先级', tone: 'danger' },
};

export const FEEDBACK_STATUS_META: Record<FeedbackStatus, { label: string; tone: Tone }> = {
  open: { label: '待处理', tone: 'warning' },
  resolved: { label: '已处理', tone: 'success' },
  ignored: { label: '已忽略', tone: 'neutral' },
};

export function plural(count: number, unit: string): string {
  return `${count} ${unit}`;
}
