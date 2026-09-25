# patches/

English | [中文](README.zh.md)

Minimal patches to upstream deepseek-harness configuration files (the monorepo compatibility layer).

## 0001-monorepo-compat.patch

- Root `package.json`: `name` changed to `app-dsh` (the monorepo check requires name = directory name), plus `dev`/`start` scripts.
- `tsconfig.host.json`: four dsh plugin packages added to the references array (integration/plugin-kestra-sync, integration/plugin-nacos-config, guard/plugin-fault-tolerance, guard/plugin-runtime-guard).

## Reapplying after an upstream update

```bash
cd app-dsh
git fetch upstream
git rebase upstream/master          # or merge
# Only two conflict points: package.json name/scripts, and the tsconfig.host.json references array (~4 lines)
git apply patches/0001-monorepo-compat.patch   # if the patch is not already in the branch
pnpm install && CI=true pnpm run build && pnpm exec vitest run packages/integration packages/guard
```

The plugin directories (the four dsh plugins added under packages/) are pure additions and never need to merge with upstream.
