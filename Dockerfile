# dsh(PC) 运行时镜像 —— 双入口多阶段构建
#
#   builder：完整工作区安装 + host-face lib 构建（tsc -b + tsdown）
#   runtime ：复制构建产物，默认 headless 一次性入口（Kestra AIAgent 容器契约）
#
# 两种用法：
#   headless（默认，Kestra AIAgent 驱动）：
#     docker run --rm -e DSH_PROMPT="…" -e DEEPSEEK_API_KEY=… ghcr.io/ai-specs/dsh
#   web 常驻（开发模式）：
#     docker run -p 3000:3000 ghcr.io/ai-specs/dsh pnpm dsh web --port 3000
#
# 说明：runtime 保留完整 node_modules —— dsh 启动器是 workspace 源码模式
# （`pnpm dsh` = node --import tsx/esm apps/cli/src/bin.ts），插件加载器按包名
# 从工作区 node_modules 解析 Cordis 插件，因此 dev 依赖无法安全剪除。

# ── builder：安装 + 构建 ─────────────────────────────────────────────────────
FROM node:24-slim AS builder
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app

# 工作区安装需要全部 importer 目录在场（packages/*/*、apps/* 等都是 workspace
# 成员），因此源码先于 pnpm install 拷贝；换锁文件外的源码会重新安装，
# 这是正确性与缓存粒度的折中。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
# patchedDependencies 由 pnpm-workspace.yaml 引用，缺 patches/ 会让 install 直接 254
COPY patches patches
COPY vendor vendor
COPY native native
COPY packages packages
COPY apps apps
# registry 走 pnpm 默认（npmjs，完整但慢），显式加大超时与重试；
# npmmirror 作为回退（快，但个别平台 tarball 重定向会超时）。
# store 走 BuildKit 缓存挂载：COPY 层变化时不重下依赖。
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    (CI=true pnpm install --no-frozen-lockfile --ignore-scripts \
      --fetch-timeout=300000 --fetch-retries=5 --fetch-retry-maxtimeout=120000 \
  || CI=true pnpm install --no-frozen-lockfile --ignore-scripts \
      --registry=https://registry.npmmirror.com \
      --fetch-timeout=300000 --fetch-retries=5 --fetch-retry-maxtimeout=120000)
# 以下是纯编译输入（非 workspace 成员）：变更只影响缓存到这一层为止
COPY tsconfig.json tsconfig.base.json tsconfig.host.json tsconfig.client.json tsdown.config.ts ./
# host 工程的 include 覆盖 apps/packages/scripts/website 四个顶层目录，缺一不可
COPY scripts scripts
COPY website website
# 工作区 lib/ 由构建机预构建（见 docs）。根复合构建 tsc -b tsconfig.host.json
# 在本 fork 工作树存在与运行时无关的遗留 TS6307（上游复合工程边界问题），因此
# 镜像内不重建全库，改为对 AIAgent 容器契约产物做强制验证门——缺失或不可加载
# 即镜像失败。
RUN node --input-type=module -e "\
    import('/app/packages/integration/plugin-kestra-run/lib/index.js')\
      .then(m => { if (m.name !== 'kestra-run') throw new Error('bad plugin name: ' + m.name);\
        console.log('kestra-run plugin module OK'); })\
      .catch(e => { console.error(e); process.exit(1); })" \
 && test -x /app/packages/integration/plugin-kestra-run/bin/dsh-run.mjs \
 && test -f /app/packages/integration/plugin-kestra-run/dsh.patch.yml \
 && test -f /app/packages/integration/plugin-kestra-run/lib/types/index.d.ts \
 && echo "dsh runtime contract artifacts OK"

# ── runtime：构建产物 + 启动入口 ─────────────────────────────────────────────
FROM node:24-slim
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    DSH_HOME=/root/.dsh
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app
COPY --from=builder /app /app
ENV PATH="/app/node_modules/.bin:${PATH}"
VOLUME ["/root/.dsh"]
EXPOSE 3000
# 默认 headless 一次性入口；web 模式由 compose/Kestra 以
# command: ["pnpm", "dsh", "web", "--port", "3000"] 覆盖。
CMD ["node", "/app/packages/integration/plugin-kestra-run/bin/dsh-run.mjs"]
