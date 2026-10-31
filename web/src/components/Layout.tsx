import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  DraftingCompass,
  ListTodo,
  MessageSquareWarning,
  Settings,
  Sparkles,
  Trash2,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { cn } from '../lib/format';
import { useRealtime } from '../lib/useRealtime';
import { useToast } from '../lib/toast';
import { Badge } from './Badge';
import { Modal } from './Modal';
import { Spinner } from './Spinner';

const NAV_ITEMS = [
  { to: '/designer', label: '设计师', icon: DraftingCompass, match: (path: string) => path.startsWith('/designer') },
  { to: '/', label: '任务', icon: ListTodo, match: (path: string) => path === '/' || path.startsWith('/tasks') },
  { to: '/pipelines', label: '流水线', icon: Workflow, match: (path: string) => path.startsWith('/pipelines') },
  { to: '/agents', label: '智能体', icon: Bot, match: (path: string) => path.startsWith('/agents') },
  { to: '/skills', label: '技能库', icon: Sparkles, match: (path: string) => path.startsWith('/skills') },
  { to: '/tools', label: '工具库', icon: Wrench, match: (path: string) => path.startsWith('/tools') },
  { to: '/feedback', label: '反馈', icon: MessageSquareWarning, match: (path: string) => path.startsWith('/feedback') },
  { to: '/settings', label: '设置', icon: Settings, match: (path: string) => path.startsWith('/settings') },
];

function pageMeta(pathname: string): { title: string; subtitle: string } {
  if (pathname === '/') return { title: '任务', subtitle: '选一条流水线发起任务，看它按环节自动推进' };
  if (pathname.startsWith('/tasks/')) return { title: '任务详情', subtitle: '流水线进度、每环产出与对话过程' };
  if (pathname.startsWith('/designer')) {
    return { title: '流水线设计师', subtitle: '和系统管理员对话：讨论需求，提案确认后自动搭建智能体与流水线' };
  }
  if (pathname === '/pipelines/new' || /^\/pipelines\/[^/]+\/edit$/.test(pathname)) {
    return { title: '流水线编排', subtitle: '把智能体拖上画布，用带箭头的连线定义交接' };
  }
  if (pathname.startsWith('/pipelines')) return { title: '流水线', subtitle: '编排智能体，定义每个环节的交付与去向' };
  if (pathname.startsWith('/agents')) return { title: '智能体', subtitle: '岗位提示词、工具与技能' };
  if (pathname.startsWith('/skills')) return { title: '技能库', subtitle: '说明书 + 脚本 + 素材的技能包' };
  if (pathname.startsWith('/tools')) return { title: '工具库', subtitle: '内置工具与可编写的 JS 工具' };
  if (pathname.startsWith('/feedback')) return { title: '反馈中心', subtitle: '智能体在使用中提出的系统改进建议' };
  if (pathname.startsWith('/settings')) return { title: '设置', subtitle: '模型接入、运行参数与数据清理' };
  return { title: 'A-Team', subtitle: '轻量智能体流水线' };
}

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const connected = useRealtime();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const workspaceRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 5000,
  });
  const status = data?.status;
  const meta = useMemo(() => pageMeta(location.pathname), [location.pathname]);
  const busyCount = status?.busyAgents.length ?? 0;
  const openFeedback = data?.stats.openFeedback ?? 0;

  useEffect(() => {
    document.title = `${meta.title} · A-Team`;
  }, [meta.title]);

  // 切换页面时回到内容顶部
  useEffect(() => {
    const el = workspaceRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  }, [location.pathname]);

  const resetMutation = useMutation({
    mutationFn: api.reset,
    onSuccess: () => {
      setResetOpen(false);
      setResetText('');
      queryClient.clear();
      navigate('/');
      toast.success('已清空全部任务与工作目录');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand" aria-label="A-Team 首页">
          <span className="brand-mark">
            <svg viewBox="0 0 64 64" aria-hidden="true">
              <defs>
                <linearGradient id="brand-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop stopColor="#8ba6ff" />
                  <stop offset="1" stopColor="#b79cff" />
                </linearGradient>
              </defs>
              <path d="M18 43 32 16l14 27-7 4-7-13-7 13z" fill="url(#brand-gradient)" />
            </svg>
          </span>
          <span className="brand-text">
            <strong>A-TEAM</strong>
            <small>Agent Pipeline</small>
          </span>
        </Link>

        <nav className="nav">
          {NAV_ITEMS.map((item) => {
            const active = item.match(location.pathname);
            const isFeedback = item.to === '/feedback';
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn('nav-item', active && 'nav-item--active')}
                title={item.label}
              >
                <item.icon size={18} strokeWidth={1.9} />
                <span className="nav-label">{item.label}</span>
                {isFeedback && openFeedback > 0 ? <span className="nav-badge">{openFeedback}</span> : null}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-status">
            <span className={cn('connection-dot', connected ? 'is-online' : 'is-offline')} />
            <span>{connected ? '实时连接' : '连接中…'}</span>
          </div>
          <div className="sidebar-meta">
            <Badge tone="success">Live</Badge>
            <span>v{status?.version ?? '1.0.0'}</span>
          </div>
        </div>
      </aside>

      <div className="workspace" ref={workspaceRef}>
        <header className="topbar">
          <div className="topbar-heading">
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
          <div className="topbar-actions">
            {busyCount > 0 ? (
              <span className="busy-pill">
                <span className="pulse-dot" />
                {busyCount} 个智能体运行中
              </span>
            ) : null}
            <span className={cn('live-pill', connected ? 'is-online' : 'is-offline')}>
              <span className="connection-dot" />
              {connected ? '实时' : '重连中'}
            </span>
            <button type="button" className="button button--ghost button--sm" onClick={() => setResetOpen(true)}>
              <Trash2 size={15} />
              一键清空
            </button>
          </div>
        </header>

        <main className={cn('main', location.pathname.startsWith('/designer') && 'main--fill')}>
          <Outlet />
        </main>
      </div>

      <Modal
        open={resetOpen}
        onClose={() => {
          if (!resetMutation.isPending) {
            setResetOpen(false);
            setResetText('');
          }
        }}
        title="一键清空任务数据"
        description="停止当前任务，并清空智能体的对话上下文与工作目录。"
        footer={
          <>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setResetOpen(false)}
              disabled={resetMutation.isPending}
            >
              取消
            </button>
            <button
              type="button"
              className="button button--danger"
              disabled={resetText !== '清空' || resetMutation.isPending}
              onClick={() => resetMutation.mutate()}
            >
              {resetMutation.isPending ? <Spinner size={15} /> : <Trash2 size={15} />}
              确认清空
            </button>
          </>
        }
      >
        <div className="reset-grid">
          <div className="reset-block reset-block--delete">
            <div className="reset-block-title">将删除</div>
            <ul>
              <li>全部任务记录与每个环节的产出</li>
              <li>所有智能体的对话消息</li>
              <li>任务工作区中的全部文件</li>
            </ul>
          </div>
          <div className="reset-block reset-block--keep">
            <div className="reset-block-title">将保留</div>
            <ul>
              <li>智能体、提示词与流水线配置</li>
              <li>自定义工具与技能库</li>
              <li>反馈中心的所有反馈</li>
            </ul>
          </div>
        </div>
        <div className="danger-note">
          <Users size={15} />
          此操作不可撤销。请输入「清空」以确认。
        </div>
        <input
          className="input"
          value={resetText}
          onChange={(event) => setResetText(event.target.value)}
          placeholder="输入 清空"
          autoFocus
        />
      </Modal>
    </div>
  );
}
