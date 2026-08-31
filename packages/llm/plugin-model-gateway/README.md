# @deepseek-ai/dsh-plugin-model-gateway

dsh 本地模型网关（dsh.docx：Token 经济与模型路由）：

- 统一模型调用入口，按 Nacos `dsh-model-gateway.yaml` 的路由策略按任务类型选模型
- 灰度：按 `hash(salt+userId) % 100 < percent` 命中灰度模型
- 失败自动切 fallback 模型；每次调用记录 prompt/completion/total token
- 用户自采购 API：密钥从环境变量读取（`DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等），不经 Nacos 下发
