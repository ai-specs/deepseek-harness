# patches/

[English](README.md) | 中文

对 deepseek-harness 上游配置文件的最小修改补丁（monorepo 兼容层）。

## 0001-monorepo-compat.patch

- 根 `package.json`：`name` 改为 `app-dsh`（monorepo 检查要求 name=目录名），新增 `dev`/`start` 脚本。
- `tsconfig.host.json`：references 数组新增 4 个 dsh 插件包（integration/plugin-kestra-sync、integration/plugin-nacos-config、guard/plugin-fault-tolerance、guard/plugin-runtime-guard）。

## 上游更新后重新应用

```bash
cd app-dsh
git fetch upstream
git rebase upstream/master          # or merge
# Only two conflict points: package.json name/scripts, and the tsconfig.host.json references array (~4 lines)
git apply patches/0001-monorepo-compat.patch   # if the patch is not already in the branch
pnpm install && CI=true pnpm run build && pnpm exec vitest run packages/integration packages/guard
```

插件目录（packages/ 下新增的四个 dsh 插件）为纯新增，永远不需要与上游合并。
