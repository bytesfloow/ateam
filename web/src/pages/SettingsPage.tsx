import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Save,
  Server,
  Settings2,
  ShieldAlert,
  Trash2,
  Wifi,
  Zap,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { THINKING_LEVEL_SUGGESTIONS, type AppSettings, type SettingsUpdate, type ThinkingLevel } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { CopyButton } from '../components/CopyButton';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { ToggleRow } from '../components/Toggle';
import { useToast } from '../lib/toast';

interface FormState {
  baseUrl: string;
  model: string;
  temperature: string;
  maxIterations: string;
  deepThinking: boolean;
  thinkingLevel: ThinkingLevel;
  maxContextTokens: string;
  requestTimeoutMs: string;
  apiKeyInput: string;
  searchApiKeyInput: string;
  toolTimeoutMs: string;
  commandTimeoutMs: string;
  maxToolOutputChars: string;
  maxFeedbackSnapshotMessages: string;
}

const RUNTIME_FIELDS: {
  key: keyof Pick<
    FormState,
    'toolTimeoutMs' | 'commandTimeoutMs' | 'maxToolOutputChars' | 'maxFeedbackSnapshotMessages'
  >;
  label: string;
  hint: string;
  min: number;
  max: number;
  step?: number;
}[] = [
  { key: 'toolTimeoutMs', label: '自定义工具超时', hint: '毫秒，1,000 - 600,000', min: 1000, max: 600000, step: 1000 },
  { key: 'commandTimeoutMs', label: '命令执行超时', hint: '毫秒，1,000 - 600,000', min: 1000, max: 600000, step: 1000 },
  { key: 'maxToolOutputChars', label: '工具输出上限', hint: '字符，超出会截断', min: 1000, max: 200000, step: 1000 },
  {
    key: 'maxFeedbackSnapshotMessages',
    label: '反馈快照消息数',
    hint: '提交反馈时附带的最近消息条数',
    min: 5,
    max: 100,
  },
];

function formFromSettings(settings: AppSettings): FormState {
  return {
    baseUrl: settings.llm.baseUrl,
    model: settings.llm.model,
    temperature: String(settings.llm.temperature),
    maxIterations: settings.llm.maxIterations > 0 ? String(settings.llm.maxIterations) : '',
    deepThinking: settings.llm.deepThinking,
    thinkingLevel: settings.llm.thinkingLevel,
    maxContextTokens: String(settings.llm.maxContextTokens),
    requestTimeoutMs: String(settings.llm.requestTimeoutMs),
    apiKeyInput: '',
    searchApiKeyInput: '',
    toolTimeoutMs: String(settings.runtime.toolTimeoutMs),
    commandTimeoutMs: String(settings.runtime.commandTimeoutMs),
    maxToolOutputChars: String(settings.runtime.maxToolOutputChars),
    maxFeedbackSnapshotMessages: String(settings.runtime.maxFeedbackSnapshotMessages),
  };
}

function snapshotOf(form: FormState): string {
  return JSON.stringify({ ...form, apiKeyInput: '', searchApiKeyInput: '' });
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [initialized, setInitialized] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [initialSnapshot, setInitialSnapshot] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const settings = settingsQuery.data?.settings;

  useEffect(() => {
    if (initialized || !settings) return;
    const next = formFromSettings(settings);
    setForm(next);
    setInitialSnapshot(snapshotOf(next));
    setInitialized(true);
  }, [initialized, settings]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!form) throw new Error('设置尚未加载');
      const numberField = (value: string, label: string, min: number, max: number): number => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`${label} 必须是数字`);
        if (parsed < min || parsed > max) throw new Error(`${label} 需在 ${min} - ${max} 之间`);
        return parsed;
      };
      if (!form.baseUrl.trim()) throw new Error('请填写 Base URL');
      if (!form.model.trim()) throw new Error('请填写模型名称');
      const maxIterationsText = form.maxIterations.trim();
      const maxIterations =
        maxIterationsText === '' ? 0 : numberField(maxIterationsText, '最大迭代轮数', 0, 100);
      const thinkingLevel = form.thinkingLevel.trim();
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(thinkingLevel)) {
        throw new Error('思考级别只能包含字母、数字、下划线或连字符（1-32 个字符），例如 low / medium / high');
      }
      const requestTimeoutMs = Number(form.requestTimeoutMs);
      if (!Number.isFinite(requestTimeoutMs)) throw new Error('模型请求超时必须是数字');
      if (requestTimeoutMs !== 0 && (requestTimeoutMs < 10000 || requestTimeoutMs > 3600000)) {
        throw new Error('模型请求超时需为 0（不限制）或 10,000 - 3,600,000 毫秒');
      }
      const llm: NonNullable<SettingsUpdate['llm']> = {
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        temperature: numberField(form.temperature, '温度', 0, 2),
        maxIterations,
        deepThinking: form.deepThinking,
        thinkingLevel,
        maxContextTokens: numberField(form.maxContextTokens, '最大上下文长度', 1000, 10000000),
        requestTimeoutMs: Math.round(requestTimeoutMs),
      };
      if (form.apiKeyInput.trim()) llm.apiKey = form.apiKeyInput.trim();
      const runtime: NonNullable<SettingsUpdate['runtime']> = {};
      for (const field of RUNTIME_FIELDS) {
        const value = numberField(form[field.key], field.label, field.min, field.max);
        (runtime as Record<string, number>)[field.key] = value;
      }
      const webSearch: SettingsUpdate['webSearch'] = form.searchApiKeyInput.trim()
        ? { searchApiKey: form.searchApiKeyInput.trim() }
        : undefined;
      return api.saveSettings({ llm, runtime, webSearch });
    },
    onSuccess: (data) => {
      const next = formFromSettings(data.settings);
      setForm(next);
      setInitialSnapshot(snapshotOf(next));
      setTestResult(null);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.success('设置已保存');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const clearKeyMutation = useMutation({
    mutationFn: () => api.saveSettings({ llm: { apiKey: null } }),
    onSuccess: (data) => {
      if (form) {
        const next = { ...form, apiKeyInput: '' };
        setForm(next);
        setInitialSnapshot(snapshotOf(next));
      }
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.success('已清除保存的 API Key');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('设置尚未加载');
      return api.testConnection({
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        deepThinking: form.deepThinking,
        thinkingLevel: form.thinkingLevel,
        ...(form.apiKeyInput.trim() ? { apiKey: form.apiKeyInput.trim() } : {}),
      });
    },
    onSuccess: (result) => {
      setTestResult({ ok: true, message: result.message, latencyMs: result.latencyMs });
      toast.success('模型连接正常');
    },
    onError: (error: Error) => {
      setTestResult({ ok: false, message: error.message });
      toast.error(error.message);
    },
  });

  const resetMutation = useMutation({
    mutationFn: api.reset,
    onSuccess: () => {
      setResetOpen(false);
      setResetText('');
      queryClient.clear();
      toast.success('已清空全部任务与工作目录');
      navigate('/');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (settingsQuery.isLoading || !form) {
    if (settingsQuery.isError) {
      return (
        <div className="error-panel">
          {(settingsQuery.error as Error).message}
          <button type="button" className="button button--secondary button--sm" onClick={() => settingsQuery.refetch()}>
            重试
          </button>
        </div>
      );
    }
    return (
      <div className="loading-panel">
        <Spinner size={20} /> 正在加载设置…
      </div>
    );
  }

  const dirty =
    snapshotOf(form) !== initialSnapshot || Boolean(form.apiKeyInput) || Boolean(form.searchApiKeyInput);
  const update = (patch: Partial<FormState>) => setForm({ ...form, ...patch });

  return (
    <div className="page-stack settings-page">
      <div className="config-toolbar">
        <div className="settings-title">
          <h2>系统设置</h2>
          <p>模型接入、运行安全边界与数据清理。</p>
        </div>
        <div className="config-toolbar-actions">
          {dirty ? <Badge tone="warning">有未保存修改</Badge> : <Badge tone="neutral">已保存</Badge>}
          <button
            type="button"
            className="button button--primary"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? <Spinner size={15} /> : <Save size={15} />}
            保存设置
          </button>
        </div>
      </div>

      <section className="card settings-card">
        <div className="section-head">
          <div>
            <h3>
              <Server size={16} />
              模型接入
            </h3>
            <p>兼容 OpenAI Chat Completions 协议，可接入 DeepSeek、OpenAI、通义等。</p>
          </div>
          <Badge tone={settings?.llm.apiKeySet ? 'success' : 'warning'}>
            {settings?.llm.apiKeySet ? `Key 已配置 ${settings.llm.apiKeyHint}` : '未配置 Key'}
          </Badge>
        </div>

        <ToggleRow
          checked={form.deepThinking}
          onChange={(checked) => update({ deepThinking: checked })}
          title="深度思考"
          description="开启后请求中附带推理参数，按服务方言自动适配（DeepSeek thinking / OpenAI reasoning_effort / 通义 enable_thinking）。"
        />

        <div className="form-grid form-grid--2">
          <Field label="Base URL" required hint="例如 https://api.deepseek.com/v1，不要包含 /chat/completions。">
            <input
              className="input"
              value={form.baseUrl}
              onChange={(event) => update({ baseUrl: event.target.value })}
              placeholder="https://api.deepseek.com/v1"
            />
          </Field>
          <Field label="模型名称" required hint="智能体未单独覆盖模型时使用。">
            <input
              className="input"
              value={form.model}
              onChange={(event) => update({ model: event.target.value })}
              placeholder="deepseek-chat"
            />
          </Field>
        </div>

        <Field
          label="API Key"
          hint={
            settings?.llm.apiKeySet
              ? `已保存 ${settings.llm.apiKeyHint}。留空则保持不变。`
              : '保存在本机 SQLite 中，不会返回给前端。'
          }
        >
          <div className="input-with-actions">
            <input
              className="input"
              type={showKey ? 'text' : 'password'}
              value={form.apiKeyInput}
              onChange={(event) => update({ apiKeyInput: event.target.value })}
              placeholder={settings?.llm.apiKeySet ? '输入新 Key 以替换' : 'sk-…'}
              autoComplete="off"
            />
            <button type="button" className="icon-button" onClick={() => setShowKey((value) => !value)} title="显示/隐藏">
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>

        <div className="form-grid form-grid--3">
          <Field label="默认温度" hint="0-2。智能体可单独覆盖。">
            <input
              className="input"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              onChange={(event) => update({ temperature: event.target.value })}
            />
          </Field>
          <Field label="最大迭代轮数" hint="单次运行的全局上限，0 或留空为不限制。">
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              placeholder="不限制"
              value={form.maxIterations}
              onChange={(event) => update({ maxIterations: event.target.value })}
            />
          </Field>
          <div className="field field--inline-action">
            <div className="field-label">连接测试</div>
            <div className="button-row">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? <Spinner size={15} /> : <Wifi size={15} />}
                测试连接
              </button>
              {settings?.llm.apiKeySet ? (
                <button
                  type="button"
                  className="button button--danger-ghost button--sm"
                  onClick={() => clearKeyMutation.mutate()}
                  disabled={clearKeyMutation.isPending}
                >
                  <KeyRound size={14} />
                  清除 Key
                </button>
              ) : null}
            </div>
            {testResult ? (
              <div className={testResult.ok ? 'test-result test-result--ok' : 'test-result test-result--error'}>
                {testResult.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                {testResult.message}
                {testResult.latencyMs !== undefined ? <span>（{testResult.latencyMs} ms）</span> : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="form-grid form-grid--3">
          <Field
            label="思考级别"
            hint={
              form.deepThinking
                ? '取值随模型而异，原样作为推理力度（reasoning_effort）发送，输入时有常见取值建议。'
                : '开启深度思考后生效。取值随模型而异，原样发送给模型。'
            }
          >
            <input
              className="input"
              list="thinking-level-suggestions"
              value={form.thinkingLevel}
              disabled={!form.deepThinking}
              placeholder="medium"
              autoComplete="off"
              onChange={(event) => update({ thinkingLevel: event.target.value as ThinkingLevel })}
            />
            <datalist id="thinking-level-suggestions">
              {THINKING_LEVEL_SUGGESTIONS.map((level) => (
                <option key={level} value={level} />
              ))}
            </datalist>
          </Field>
          <Field
            label="最大上下文长度（token）"
            hint="模型上下文窗口（token），默认 1,000,000（1M）。上下文达到 80% 时自动压缩，丢弃最早的对话轮次。"
          >
            <input
              className="input"
              type="number"
              min={1000}
              max={10000000}
              step={1000}
              value={form.maxContextTokens}
              onChange={(event) => update({ maxContextTokens: event.target.value })}
            />
          </Field>
          <Field
            label="模型请求超时（毫秒）"
            hint="默认 600,000（10 分钟）。流式请求下是「多久没有新数据就判定卡死」，超时会自动重试一次（第二次预算 1.5 倍）。0 表示不限制。"
          >
            <input
              className="input"
              type="number"
              min={0}
              max={3600000}
              step={10000}
              value={form.requestTimeoutMs}
              onChange={(event) => update({ requestTimeoutMs: event.target.value })}
            />
          </Field>
        </div>
      </section>

      <section className="card settings-card">
        <div className="section-head">
          <div>
            <h3>
              <Settings2 size={16} />
              运行参数
            </h3>
            <p>这些上限保护本机与上下文窗口，超出时系统会截断或拒绝。</p>
          </div>
        </div>
        <div className="form-grid form-grid--2 runtime-grid">
          {RUNTIME_FIELDS.map((field) => (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <input
                className="input"
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={form[field.key]}
                onChange={(event) => update({ [field.key]: event.target.value } as Partial<FormState>)}
              />
            </Field>
          ))}
        </div>
      </section>

      <section className="card settings-card">
        <div className="section-head">
          <div>
            <h3>
              <Globe size={16} />
              联网搜索（web_search）
            </h3>
            <p>智能体的联网搜索走 DeepSeek 搜索 API，按成功请求计费（约 5 元 / 1000 次）。web_fetch 为本机直接抓取，不产生费用。</p>
          </div>
          <Badge
            tone={
              settings?.webSearch.searchApiKeySet || settings?.webSearch.reusingLlmKey ? 'success' : 'warning'
            }
          >
            {settings?.webSearch.searchApiKeySet
              ? `搜索 Key 已配置 ${settings.webSearch.searchApiKeyHint}`
              : settings?.webSearch.reusingLlmKey
                ? '复用 DeepSeek 模型 Key'
                : '未配置搜索 Key'}
          </Badge>
        </div>
        <Field
          label="搜索 API Key"
          hint={
            settings?.webSearch.searchApiKeySet
              ? `已保存 ${settings.webSearch.searchApiKeyHint}。留空则保持不变。`
              : '留空且模型接入使用 DeepSeek（api.deepseek.com）时，自动复用模型 API Key。'
          }
        >
          <div className="input-with-actions">
            <input
              className="input"
              type="password"
              value={form.searchApiKeyInput}
              onChange={(event) => update({ searchApiKeyInput: event.target.value })}
              placeholder={settings?.webSearch.searchApiKeySet ? '输入新 Key 以替换' : 'sk-…（DeepSeek 开放平台）'}
              autoComplete="off"
            />
          </div>
        </Field>
      </section>

      <section className="card settings-card">
        <div className="section-head">
          <div>
            <h3>
              <Database size={16} />
              数据与存储
            </h3>
            <p>运行时数据保存在本机 SQLite；智能体工作目录由系统统一托管。</p>
          </div>
        </div>
        <div className="info-grid">
          <div className="info-row">
            <span>工作目录根路径</span>
            <code>{settings?.workspaceRoot}</code>
            <CopyButton value={settings?.workspaceRoot ?? ''} />
          </div>
          <div className="info-row">
            <span>数据库</span>
            <code>data/ateam.db（SQLite，WAL 模式）</code>
          </div>
          <div className="info-row">
            <span>系统版本</span>
            <span>{settings?.version}</span>
          </div>
        </div>
      </section>

      <section className="card danger-zone">
        <div className="danger-zone-copy">
          <div className="danger-zone-icon">
            <ShieldAlert size={20} />
          </div>
          <div>
            <h3>危险区域</h3>
            <p>
              一键清空会停止当前任务，删除全部任务记录、对话、每个环节的产出，以及所有任务工作区中的文件。
              智能体配置、工具、技能与反馈会保留。
            </p>
          </div>
        </div>
        <button type="button" className="button button--danger" onClick={() => setResetOpen(true)}>
          <Trash2 size={15} />
          一键清空
        </button>
      </section>

      <Modal
        open={resetOpen}
        onClose={() => {
          if (!resetMutation.isPending) {
            setResetOpen(false);
            setResetText('');
          }
        }}
        title="确认清空所有任务数据？"
        description="此操作不可撤销。建议确认没有重要的工作目录文件后再执行。"
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
              {resetMutation.isPending ? <Spinner size={15} /> : <Zap size={15} />}
              确认清空
            </button>
          </>
        }
      >
        <div className="callout callout--warning">
          <AlertTriangle size={15} />
          将删除：任务记录、对话消息、每个环节的产出、工作目录文件。保留：智能体、提示词、流水线、工具、技能、反馈。
        </div>
        <Field label="输入「清空」以确认" required>
          <input
            className="input"
            value={resetText}
            onChange={(event) => setResetText(event.target.value)}
            placeholder="清空"
            autoFocus
          />
        </Field>
      </Modal>
    </div>
  );
}
