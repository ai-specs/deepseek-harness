# @deepseek-ai/dsh-plugin-context-manager

dsh 上下文管理插件（dsh.docx 第十章）：

- **滑动窗口**：maxMessages / maxTokens 预算，超出即淘汰
- **压缩**：超过阈值（window 80%）时把被淘汰消息交给 summarize 回调生成摘要，保留 keepRecentMessages 条最近消息
- **本地向量库**：被淘汰消息的核心语义入库（词频向量，生产可替换真向量），`recall(query)` 按相关度检索
- 策略由 Nacos `dsh-context.yaml` 下发热更新
