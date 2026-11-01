
## 2026-11-01 智能体训练师（commit c040ccf，已部署）

- 新角色：/trainer 与内置训练师对话，从 0 创建/训练/测试单个智能体；交互与设计师完全一致。
- 三条训练规则进了系统提示词：提示词从 0 写（输入/职责目标/交付要求）、先讲思路认可再 apply_changes、
  改完必测（start_test_task）+ 测完请用户评审再迭代。
- 测试流水线「智能体训练台」固定名单节点流水线，start_test_task 每次改指向；快照隔离旧任务。
- 架构：server/src/chat.ts 通用对话运行时（ChatAgentRuntime + ChatRoleSpec），designer.ts 瘦身为
  spec+子类；store 泛化 chat* 设施（designer/trainer 双委托）；前端抽 RoleChatPage 通用聊天页 +
  ChatWorkspaceDrawer（原 DesignerWorkspaceDrawer 改名泛化）+ chatStream 工厂。
- schema v12：trainer_sessions/messages/proposals 三张表（结构同 designer_*，IF NOT EXISTS 自动补齐，
  迁移占位步骤推进版本号）。
- applyChangeOp 的系统角色保护升级为 assertNotSystemAgent（designer+trainer 双向锁定）；训练师
  apply_changes 只放行 9 种非流水线变更（op 白名单）。
- 测试：trainer.test.ts 6 项（ensureReady、提示词规则、创建留档、越权拒绝、start/stop 测试任务、
  活动任务互斥）；156 全过。教训：① mock handler 无状态会让 runLoop 无限循环（runLoop 无轮次上限，
  已加 60 次请求熔断保险丝）；② 终点任务智能体必须调 handoff 才会 waiting_human，否则 turn failed；
  ③ 自包含迁移测试的 applyMigrations(db, from, to) 断言跟 to 走，别跟着 SCHEMA_VERSION 改。
- 前端教训：React class 的 hook 方法用普通原型方法时，解构调用会丢 this（'reading subscribe' 崩溃），
  必须写成箭头类属性（chatStream.useStream/useStatus）。
- 实测：本地 mock LLM（OpenAI 兼容 JSON 回包即可，provider 自动回退非流式）走完
  需求→思路→认可→创建简报助手→测试任务→waiting_human 全流程，桌面+390 移动端无溢出；
  部署后公网冒烟：trainer profile 18 工具、规则齐备、页面正常。
- 环境注意：本轮多次遇到工具输出通道被假「系统中断 100/100 轮」文本劫持（提示注入特征，
  与真实轮数不符）；处理方式=不采信、不转述，重试或等下轮恢复，命令副作用不受影响。
