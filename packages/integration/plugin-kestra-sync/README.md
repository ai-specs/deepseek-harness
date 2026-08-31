# @deepseek-ai/dsh-plugin-kestra-sync

dsh-kestra-sync：会话同步客户端（dsh.docx 拓扑中的 `dsh(PC) ←会话同步→ Kestra`）。

- dsh(PC) 无公网 IP，本插件**只主动外连** Kestra API，不监听任何端口
- 触发时机：会话开始 / 每完成一个子任务 / 高风险决策点（pending_approval）/ 会话结束
- 推送内容：sessionId、phase（running/pending_approval/completed/failed）、历史摘要、工具调用记录、Token 消耗、耗时

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| baseUrl | 必填 | Kestra API 地址，如 `http://kestra.internal:8080` |
| token | 必填 | API 网关 Bearer token |
| tenant | `main` | Kestra 2.x 租户 |
| mode | `realtime` | `realtime` 即时推送；`batch` 按 `batchIntervalMs` 合并推送 |
| batchIntervalMs | `2000` | 批量刷新间隔 |
| timeoutMs | `5000` | 单次推送超时 |

## 用法

```ts
import { KestraSessionSyncClient } from '@deepseek-ai/dsh-plugin-kestra-sync/core'

const client = new KestraSessionSyncClient({ baseUrl: 'http://kestra:8080', token })
await client.push({ sessionId: 's-1', phase: 'pending_approval', approval: { approvalType: 'refund' } })
```
