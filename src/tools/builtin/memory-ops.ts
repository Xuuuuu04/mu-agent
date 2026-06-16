// Barrel:记忆类工具按域拆到 memory/ 子目录,这里聚合导出保持旧 import 路径。
// mu.ts(注册 9 个工具)、commands.ts(searchKnowledge)、test 脚本均无需改动。
export { memorySaveTool, memorySearchTool, memoryUpdateTool, memoryForgetTool } from './memory/facts.js'
export { commitmentCreateTool, commitmentDoneTool } from './memory/commitments.js'
export { knowledgeWriteTool, searchKnowledge } from './memory/knowledge.js'
export { diaryWriteTool } from './memory/diary.js'
export { streamNoteTool } from './memory/stream.js'
