# patches/

对 deepseek-harness 上游配置文件的最小修改补丁（monorepo 兼容层）。

## 0001-monorepo-compat.patch

- 根 package.json：`name` 改为 `app-dsh`（monorepo 检查要求 name=目录名），新增 `dev`/`start` 脚本
- tsconfig.host.json：references 数组新增 6 个 dsh 插件包（integration/plugin-kestra-sync、integration/plugin-nacos-config、guard/plugin-fault-tolerance、guard/plugin-runtime-guard、llm/plugin-model-gateway、context/plugin-context-manager）

## 上游更新后重新应用

```bash
cd app-dsh
git fetch upstream
git rebase upstream/master          # 或 merge
# 冲突点仅两处：package.json 的 name/scripts、tsconfig.host.json 的 references 数组（约 6 行）
git apply patches/0001-monorepo-compat.patch   # 如补丁尚未包含在分支中
pnpm install && CI=true pnpm run build && pnpm exec vitest run packages/integration packages/guard packages/llm/plugin-model-gateway packages/context/plugin-context-manager
```

插件目录（packages/ 下新增的六个 dsh 插件）为纯新增，永远不需要与上游合并。
