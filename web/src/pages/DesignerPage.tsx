import { DraftingCompass } from 'lucide-react';
import { RoleChatPage, type RoleChatConfig } from './RoleChatPage';

/** 设计师的页面配置：交互与训练师完全一致，只差文案、图标与 API 前缀。 */
const DESIGNER_CHAT_CONFIG: RoleChatConfig = {
  kind: 'designer',
  Icon: DraftingCompass,
  title: '流水线设计师',
  idleHint: '提问澄清 → 设计思路 → 认可即执行',
  emptyTitle: '和设计师聊聊你想自动化的流程',
  placeholder:
    '描述你的需求，例如：我想搭一条「翻译 → 校对 → 排版」的文档翻译流水线（可直接粘贴图片或拖入文件）',
  thinkingText: '正在思考…',
  roleName: '设计师',
  profileTitle: '流水线设计师 · 详情',
  roleToolLabel: '设计师专属',
  skillsEmptyDescription: '设计师档案没有勾选任何技能包；如需为它扩充能力，可在「智能体」页编辑它的技能配置。',
  workspace: {
    root: 'designer',
    title: '设计师 · 工作目录',
    description: '设计师的系统级专属工作目录（跨会话持久）。这里只读浏览与预览；需要整理文件时直接在对话里告诉设计师。',
    emptyTitle: '目录是空的',
    emptyDescription: '设计师还没有在这里存放文件。上传的对话附件会出现在 uploads\\ 下；也可以在对话里让设计师把草稿写进工作目录。',
    truncatedHint: '可在对话里让设计师整理这个目录。',
    buttonTitle: '工作目录：浏览与预览设计师的文件',
  },
  clearDialog: {
    title: '清空对话记录？',
    description: '将删除全部消息、变更记录与上传的附件；设计师工作目录里的文件与已生效的系统变更不受影响。清空后从全新会话开始。',
  },
  profileButtonTitle: '设计师详情：系统提示词 / 工具 / 技能',
};

export function DesignerPage() {
  return <RoleChatPage config={DESIGNER_CHAT_CONFIG} />;
}
