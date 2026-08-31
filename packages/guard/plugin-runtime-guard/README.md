# @deepseek-ai/dsh-plugin-runtime-guard

dsh 运行时防护插件（dsh.docx 第十二章 稳定性兜底）：

- **防死锁计数器**：同一工具+同参指纹连续 `loopRepeatThreshold`（默认 3）次即判循环并强制打断
- **执行深度检测**：子任务嵌套深度超 `maxDepth`（默认 8）强制终止
- **Token 消耗监控**：单会话超 `tokenBudget`（默认 500000）告警/熔断
- 防护事件经 `onEvent` 上报 Kestra 观察中心（配合 dsh-kestra-sync）
