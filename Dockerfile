# dsh(PC) 运行时镜像 —— dev 增量形态（基于 dsh-base:dev）
#
# 角色定位：源码覆盖形态。Dockerfile.base 烘焙「环境 + 全量依赖 + 原生预编译 +
# 契约门」（tag dsh-base:dev，依赖变更时 bun run build:dsh:base 重建）；本文件
# 只做增量三件事：
#   1) FROM dsh-base:dev（依赖已就绪；平台差异已在 base 内按 Linux 容器解决，
#      宿主 macOS 不参与编译，产物可进容器）；
#   2) COPY 最新源码覆盖 /app 对应路径（路径集合与 Dockerfile.base 一致，
#      node_modules 保留 base 版本）；
#   3) 补运行时配置（PATH / DSH_HOME / VOLUME / EXPOSE / CMD）。
# 因此：源码变更 = 秒级增量构建；pnpm-lock.yaml / patches / native 平台包清单
# 变更 = 先重建 base（bun run build:dsh:base）。
# 镜像新鲜由 compose pull_policy: build 保证。
#
# 两种用法：
#   headless（默认，Kestra AIAgent 驱动）：
#     docker run --rm -e DSH_PROMPT="…" -e DEEPSEEK_API_KEY=… ghcr.io/ai-specs/dsh
#   web 常驻（开发模式）：
#     docker run -p 3000:3000 ghcr.io/ai-specs/dsh pnpm dsh web --port 3000
FROM dsh-base:dev

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY patches patches
COPY vendor vendor
COPY native native
COPY packages packages
COPY apps apps
COPY scripts scripts
COPY website website
COPY tsconfig.json tsconfig.base.json tsconfig.host.json tsconfig.client.json tsdown.config.ts ./

ENV PATH="/app/node_modules/.bin:${PATH}" \
    DSH_HOME=/root/.dsh
VOLUME ["/root/.dsh"]
EXPOSE 3000
# 默认 headless 一次性入口；web 模式由 compose/Kestra 以
# command: ["pnpm", "dsh", "web", "--port", "3000"] 覆盖。
CMD ["node", "/app/packages/integration/plugin-kestra-run/bin/dsh-run.mjs"]
