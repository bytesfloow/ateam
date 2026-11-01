import { GraduationCap } from 'lucide-react';
import { RoleChatPage, type RoleChatConfig } from './RoleChatPage';

/** 训练师的页面配置：交互与设计师完全一致，只差文案、图标与 API 前缀。 */
const TRAINER_CHAT_CONFIG: RoleChatConfig = {
  kind: 'trainer',
  Icon: GraduationCap,
  title: '智能体训练师',
  idleHint: '澄清需求 → 讲思路 → 认可即改 → 改完必测',
  emptyTitle: '和训练师聊聊你想打造的智能体',
  placeholder:
    '描述你想打造的智能体，例如：帮我打造一个每周把群聊记录整理成周报的智能体（可直接粘贴图片或拖入文件）',
  thinkingText: '正在思考…',
  roleName: '训练师',
  profileTitle: '智能体训练师 · 详情',
  roleToolLabel: '训练师专属',
  skillsEmptyDescription: '训练师档案没有勾选任何技能包；如需为它扩充能力，可在「智能体」页编辑它的技能配置。',
  workspace: {
    root: 'trainer',
    title: '训练师 · 工作目录',
    description: '训练师的系统级专属工作目录（跨会话持久）。这里只读浏览与预览；需要整理文件时直接在对话里告诉训练师。',
    emptyTitle: '目录是空的',
    emptyDescription: '训练师还没有在这里存放文件。上传的对话附件会出现在 uploads\\ 下；也可以在对话里让训练师把训练记录写进工作目录。',
    truncatedHint: '可在对话里让训练师整理这个目录。',
    buttonTitle: '工作目录：浏览与预览训练师的文件',
  },
  clearDialog: {
    title: '清空对话记录？',
    description: '将删除全部消息、变更记录与上传的附件；训练师工作目录里的文件与已生效的训练变更不受影响。清空后从全新会话开始。',
  },
  profileButtonTitle: '训练师详情：系统提示词 / 工具 / 技能',
};

export function TrainerPage() {
  return <RoleChatPage config={TRAINER_CHAT_CONFIG} />;
}
