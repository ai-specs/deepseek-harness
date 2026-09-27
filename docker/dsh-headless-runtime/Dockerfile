# dsh-headless-runtime —— 上游 @deepseek-ai/dsh 无头执行面镜像
#
# 目的：替代自研 io.kestra.plugin.dsh.agent.AIAgent（dsh-in-docker 执行面），
# 由 Kestra plugin-docker cli.Run 直接运行上游 npm 分发的 dsh（OpenAI 兼容协议）。
#
# 镜像 tag 约定：与上游 dsh npm 包版本一致（如 0.1.7-rc.1），由 CI
# （.github/workflows/publish-dsh-headless-runtime.yml）构建推送到
# ghcr.io/ai-specs/dsh-headless-runtime:<version>；本地构建：
#   docker build -t dsh-headless-runtime:<version> docker/dsh-headless-runtime
#
# ============================================================
# 【版本升级义务 —— 下次 AI 必读】
# 本镜像发布"上游 @deepseek-ai/dsh"的 npm 包，与 fork 自身版本号（本仓库
# package.json / 0.1.7-rc.1 线）不一定同步：fork merge 上游 release 后，
# 若上游已发布新版本（dist-tags.alpha / next / latest），本镜像默认版本就是过期的。
#
# 升级判断（无需人工猜测，两条命令即可）：
#   1) npm view @deepseek-ai/dsh dist-tags --json   # 读 dist-tags.alpha
#   2) 比较 dist-tags.alpha 与下方 ARG 默认值 / GHCR 现有 tag
#
# 升级动作（四步，缺一不可）：
#   1) 改本文件 ARG DSH_VERSION 默认值（下方）与文件头示例；
#   2) 同步更新 ../.github/workflows/publish-dsh-headless-runtime.yml
#      的 inputs.dsh_version 描述示例与顶部注释；
#   3) 触发 GHCR 发布：gh workflow run "Publish dsh headless runtime image"
#      -f dsh_version=<新版本>（登录 GitHub 凭据后执行）；
#   4) 本地验证：docker build -t dsh-headless-runtime:<新版本> 该目录，
#      并确认 dsh --version 输出与版本一致。
#
# 当前已发布基线：0.1.7-rc.1（上游 dist-tags.next，2026-09-24 发布；
# dist-tags.latest=0.1.5-rc.3 是稳定线，alpha=0.1.7-alpha.2 已被 next 取代）。
# 升级判断：npm view @deepseek-ai/dsh dist-tags --json 取 dist-tags.next。
# ============================================================
#
# 用法（Kestra flow 或手动）：
#   docker run --rm \
#     -e DEEPSEEK_API_KEY=... \
#     -e DEEPSEEK_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
#     -e DEEPSEEK_MODEL_NAME=deepseek-v4-flash \
#     dsh-headless-runtime:0.1.7-rc.1 \
#     --profile headless "用一句话回答：1+1等于几？"
#
# 说明：
# - 模型接入走上游 llm-pi-ai（openai-completions 原生协议）：入口脚本按环境变量
#   生成 patch overlay（$DSH_HOME/patch-llm.yml）并经 `dsh --patch` 注入，注册
#   dashscope provider（真实接入商身份，修复 UI"设置→模型"显示错位），并把
#   DEEPSEEK_BASE_URL / DEEPSEEK_MODEL_NAME 注入 llm-pi-ai providers.dashscope。
#   headless 无 settings 服务（settings.yaml 不加载），注入必须走 patch 层。
#   llm-deepseek 已恢复上游（messages 单协议），不再做 protocol 定制（2026-09-27 去定制）。
# - 镜像内不烧死端点：BASE_URL / MODEL 全部由运行时环境变量驱动，
#   与项目 .env 的 DEEPSEEK_* 三变量直接对齐。
# - node-pty 原生模块在 glibc 镜像（node:22-slim）有 prebuild，alpine/musl 没有。

ARG DSH_VERSION=0.1.7-rc.1

FROM node:22-slim

ARG DSH_VERSION

ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

# 全局安装上游 dsh（无头模式；node-pty 原生模块在 glibc 镜像有 prebuild）
RUN npm i -g @deepseek-ai/dsh@${DSH_VERSION} --no-audit --no-fund \
 && dsh --version

COPY entrypoint.sh /usr/local/bin/dsh-entrypoint
RUN chmod +x /usr/local/bin/dsh-entrypoint

ENTRYPOINT ["dsh-entrypoint"]
CMD ["--profile", "headless"]
