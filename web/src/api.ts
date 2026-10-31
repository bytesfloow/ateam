import type {
  Agent,
  AgentInput,
  AppSettings,
  CustomTool,
  CustomToolInput,
  DeliverablePreview,
  DesignerAttachment,
  DesignerProfile,
  DesignerProposal,
  DesignerSession,
  DesignerSessionDetail,
  DesignerSessionSummary,
  DesignerWorkspaceFilePreview,
  DesignerWorkspaceListing,
  Feedback,
  FeedbackUpdate,
  Pipeline,
  PipelineInput,
  SettingsUpdate,
  Skill,
  SkillFile,
  SkillFileInput,
  SkillInput,
  Stats,
  StatusSnapshot,
  TaskDetail,
  TaskSummary,
  ThinkingLevel,
  TurnDetail,
  BuiltinToolInfo,
} from '@shared/types';

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const body = payload as { error?: string; details?: unknown } | null;
    const message =
      (body && typeof body === 'object' && body.error) ||
      (typeof payload === 'string' ? payload : '') ||
      `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status, body?.details);
  }
  return payload as T;
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export interface StatusResponse {
  status: StatusSnapshot;
  stats: Stats;
}

export interface ToolsResponse {
  tools: CustomTool[];
  builtin: BuiltinToolInfo[];
  usage: Record<string, { id: string; name: string }[]>;
}

export interface FeedbackResponse {
  items: Feedback[];
  counts: { all: number; open: number; resolved: number; ignored: number };
}

export interface DemoSeedResponse {
  agents: Agent[];
  skills: Skill[];
  pipeline: Pipeline;
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  stats: () => request<{ stats: Stats }>('/api/stats'),
  health: () => request<{ ok: boolean; version: string }>('/api/health'),

  getSettings: () => request<{ settings: AppSettings }>('/api/settings'),
  saveSettings: (input: SettingsUpdate) => request<{ settings: AppSettings }>('/api/settings', json('PUT', input)),
  testConnection: (input: {
    baseUrl?: string;
    model?: string;
    apiKey?: string | null;
    deepThinking?: boolean;
    thinkingLevel?: ThinkingLevel;
  }) => request<{ ok: true; message: string; latencyMs: number }>('/api/settings/test', json('POST', input)),

  listAgents: () => request<{ agents: Agent[] }>('/api/agents'),
  createAgent: (input: AgentInput) => request<{ agent: Agent }>('/api/agents', json('POST', input)),
  previewAgentPrompt: (input: Partial<AgentInput>) =>
    request<{ prompt: string }>('/api/agents/preview-prompt', json('POST', input)),
  updateAgent: (id: string, input: Partial<AgentInput>) =>
    request<{ agent: Agent }>(`/api/agents/${encodeURIComponent(id)}`, json('PATCH', input)),
  deleteAgent: (id: string) => request<void>(`/api/agents/${encodeURIComponent(id)}`, json('DELETE')),

  listPipelines: () => request<{ pipelines: Pipeline[] }>('/api/pipelines'),
  createPipeline: (input: PipelineInput) =>
    request<{ pipeline: Pipeline }>('/api/pipelines', json('POST', input)),
  updatePipeline: (id: string, input: PipelineInput) =>
    request<{ pipeline: Pipeline }>(`/api/pipelines/${encodeURIComponent(id)}`, json('PATCH', input)),
  deletePipeline: (id: string) =>
    request<void>(`/api/pipelines/${encodeURIComponent(id)}`, json('DELETE')),

  listSkills: () => request<{ skills: Skill[] }>('/api/skills'),
  createSkill: (input: SkillInput) => request<{ skill: Skill }>('/api/skills', json('POST', input)),
  updateSkill: (id: string, input: Partial<SkillInput>) =>
    request<{ skill: Skill }>(`/api/skills/${encodeURIComponent(id)}`, json('PATCH', input)),
  deleteSkill: (id: string) => request<void>(`/api/skills/${encodeURIComponent(id)}`, json('DELETE')),
  getSkillFile: (id: string, path: string) =>
    request<{ file: SkillFile; encoding: 'utf8' | 'base64'; content: string }>(
      `/api/skills/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
    ),
  putSkillFile: (id: string, input: SkillFileInput) =>
    request<{ skill: Skill }>(`/api/skills/${encodeURIComponent(id)}/file`, json('PUT', input)),
  deleteSkillFile: (id: string, path: string) =>
    request<{ skill: Skill }>(
      `/api/skills/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
      json('DELETE'),
    ),
  renameSkillFile: (id: string, from: string, to: string) =>
    request<{ skill: Skill }>(
      `/api/skills/${encodeURIComponent(id)}/file/rename`,
      json('POST', { from, to }),
    ),
  skillFileUrl: (id: string, path: string, download = false) =>
    `/api/skills/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${
      download ? '&download=1' : ''
    }`,

  listTools: () => request<ToolsResponse>('/api/tools'),
  createTool: (input: CustomToolInput) => request<{ tool: CustomTool }>('/api/tools', json('POST', input)),
  updateTool: (id: string, input: Partial<CustomToolInput>) =>
    request<{ tool: CustomTool }>(`/api/tools/${encodeURIComponent(id)}`, json('PATCH', input)),
  deleteTool: (id: string) => request<void>(`/api/tools/${encodeURIComponent(id)}`, json('DELETE')),

  listTasks: (limit = 50) => request<{ tasks: TaskSummary[] }>(`/api/tasks?limit=${limit}`),
  startTask: (input: { task: string; pipelineId: string }) =>
    request<{ task: TaskDetail }>('/api/tasks', json('POST', input)),
  getTask: (id: string) => request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}`),
  terminateTask: (id: string) =>
    request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}/terminate`, json('POST', {})),
  retryTask: (id: string, input: { note?: string } = {}) =>
    request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}/retry`, json('POST', input)),
  completeTaskByHuman: (id: string) =>
    request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(id)}/complete`, json('POST', {})),
  getTurnDetail: (taskId: string, turnId: string) =>
    request<{ detail: TurnDetail }>(
      `/api/tasks/${encodeURIComponent(taskId)}/turns/${encodeURIComponent(turnId)}`,
    ),
  /** 交付文件夹内的文件清单（路径 / 名称 / 大小）。 */
  listDeliverables: (taskId: string, turnId: string) =>
    request<{
      folder: { path: string; name: string; files: number; bytes: number };
      files: { path: string; name: string; size: number }[];
    }>(`/api/tasks/${encodeURIComponent(taskId)}/turns/${encodeURIComponent(turnId)}/deliverable?mode=list`),
  /** 交付物文本/元数据预览（图片、PDF 请用 deliverableRawUrl）。 */
  getDeliverablePreview: (taskId: string, turnId: string, path: string) =>
    request<{ deliverable: DeliverablePreview }>(
      `/api/tasks/${encodeURIComponent(taskId)}/turns/${encodeURIComponent(turnId)}/deliverable?mode=preview&path=${encodeURIComponent(path)}`,
    ),
  /** 交付物原始字节地址（mode=raw inline / mode=download 附件），可直接用于 img / iframe / a[href]。 */
  deliverableUrl: (taskId: string, turnId: string, path: string, mode: 'raw' | 'download' = 'raw') =>
    `/api/tasks/${encodeURIComponent(taskId)}/turns/${encodeURIComponent(turnId)}/deliverable?mode=${mode}&path=${encodeURIComponent(path)}`,

  listFeedback: (status = 'all', category = 'all', agentId = '') => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (category !== 'all') params.set('category', category);
    if (agentId) params.set('agentId', agentId);
    const query = params.toString();
    return request<FeedbackResponse>(`/api/feedback${query ? `?${query}` : ''}`);
  },
  updateFeedback: (id: string, input: FeedbackUpdate) =>
    request<{ feedback: Feedback }>(`/api/feedback/${encodeURIComponent(id)}`, json('PATCH', input)),

  listDesignerSessions: () =>
    request<{
      sessions: DesignerSessionSummary[];
      busy: boolean;
      busySessionId: string | null;
    }>('/api/designer/sessions'),
  createDesignerSession: (title?: string) =>
    request<{ session: DesignerSession }>('/api/designer/sessions', json('POST', title ? { title } : {})),
  getDesignerSession: (id: string) =>
    request<DesignerSessionDetail>(`/api/designer/sessions/${encodeURIComponent(id)}`),
  deleteDesignerSession: (id: string) =>
    request<{ session: DesignerSession }>(`/api/designer/sessions/${encodeURIComponent(id)}`, json('DELETE')),
  sendDesignerMessage: (id: string, content: string, attachments: Pick<DesignerAttachment, 'name' | 'path'>[] = []) =>
    request<{ accepted: boolean }>(
      `/api/designer/sessions/${encodeURIComponent(id)}/messages`,
      json('POST', { content, ...(attachments.length > 0 ? { attachments } : {}) }),
    ),
  /** 上传对话附件：原始字节直传，保存到该会话的上传目录。 */
  uploadDesignerFile: (sessionId: string, file: File) =>
    request<{ attachment: DesignerAttachment }>(
      `/api/designer/uploads?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
    ),
  /** 已上传附件的访问地址（图片可直接作为 img src 预览）。 */
  designerUploadUrl: (sessionId: string, path: string, download = false) =>
    `/api/designer/uploads/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}${
      download ? '&download=1' : ''
    }`,
  /** 设计师详情：实时拼装的系统提示词、生效工具、技能与运行时信息。 */
  getDesignerProfile: () => request<{ profile: DesignerProfile }>('/api/designer/profile'),
  /** 设计师工作目录某一层的清单（path 为空表示根目录）。 */
  listDesignerWorkspace: (path = '') =>
    request<{ listing: DesignerWorkspaceListing }>(
      `/api/designer/workspace?mode=list&path=${encodeURIComponent(path)}`,
    ),
  /** 工作目录文件的文本/元数据预览（图片、PDF 请用 designerWorkspaceUrl 的 raw 地址）。 */
  getDesignerWorkspacePreview: (path: string) =>
    request<{ file: DesignerWorkspaceFilePreview }>(
      `/api/designer/workspace?mode=preview&path=${encodeURIComponent(path)}`,
    ),
  /** 工作目录文件原始字节地址（mode=raw inline / mode=download 附件），可直接用于 img / iframe / a[href]。 */
  designerWorkspaceUrl: (path: string, mode: 'raw' | 'download' = 'raw') =>
    `/api/designer/workspace?mode=${mode}&path=${encodeURIComponent(path)}`,
  stopDesigner: () => request<{ stopped: boolean }>('/api/designer/stop', json('POST', {})),
  /** 手动压缩上下文（摘要式）：compressed=0 表示当前用量未超水位、无需压缩。 */
  compressDesigner: () => request<{ compressed: number }>('/api/designer/compress', json('POST', {})),
  /** 清空对话记录：删除当前会话（消息、全部提案、上传附件），从全新会话开始。 */
  clearDesignerConversation: () => request<{ cleared: boolean }>('/api/designer/clear', json('POST', {})),
  approveDesignerProposal: (id: string) =>
    request<{ proposal: DesignerProposal }>(`/api/designer/proposals/${encodeURIComponent(id)}/approve`, json('POST', {})),
  rejectDesignerProposal: (id: string) =>
    request<{ proposal: DesignerProposal }>(`/api/designer/proposals/${encodeURIComponent(id)}/reject`, json('POST', {})),

  reset: () =>
    request<{ result: { tasks: number; turns: number; messages: number } }>(
      '/api/reset',
      json('POST', { confirm: true }),
    ),
  seedDemo: () => request<DemoSeedResponse>('/api/demo/seed', json('POST', {})),
};

export type { TaskDetail, TaskSummary };
