# @deepseek-ai/dsh-plugin-fault-tolerance

dsh 本地容错插件（dsh.docx 第九章）：工具调用失败被本层拦截，**底层错误不透传给用户**。

- 指数退避重试：默认 4 次，1s → 2s → 4s → 8s（baseDelayMs × multiplier^(n-1)）
- 兜底降级：重试耗尽后按正则匹配兜底规则库，返回安全默认答复
- 熔断：连续失败达阈值（默认 5）进入 open，openSeconds 后 half_open 探测

配置全部由 Nacos `dsh-fault-tolerance.yaml` 下发映射而来。
