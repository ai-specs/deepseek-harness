#!/bin/sh
# dsh-headless-runtime 入口：按环境变量生成 LLM 接入 patch overlay 后转交 dsh。
# 与项目 .env 对齐的变量：DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL_NAME
#
# 模型接入走上游 llm-pi-ai（openai-completions 原生协议，DashScope 真实 provider 身份）。
# 注入方式 = dsh --patch overlay（headless 无 settings 服务，settings.yaml 不加载；
# 2026-09-27 去定制，llm-deepseek 已恢复上游 messages 单协议，不再生成/依赖 settings.yaml）。
set -e

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$DSH_HOME"

BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com}"
MODEL="${DEEPSEEK_MODEL_NAME:-deepseek-chat}"

PATCH_FILE="$DSH_HOME/patch-llm.yml"
# openai-completions 协议请求 {baseURL}/chat/completions，
# 因此 DEEPSEEK_BASE_URL 需包含 /v1（如 https://dashscope.aliyuncs.com/compatible-mode/v1）。
cat > "$PATCH_FILE" <<EOF
# LLM 接入 overlay（dsh --patch 注入，2026-09-27 起 pi-ai 接入 DashScope）
- id: llm-pi-ai
  config:
    providers:
      dashscope:
        apiKeyEnv: DEEPSEEK_API_KEY
        api: openai-completions
        baseURL: ${BASE_URL}
        models:
          - id: ${MODEL}
            name: ${MODEL}
            contextWindow: 1000000
            input:
              - text

- id: agent-default-model
  config:
    provider: dashscope
    model: ${MODEL}
EOF

exec dsh --patch "$PATCH_FILE" "$@"
