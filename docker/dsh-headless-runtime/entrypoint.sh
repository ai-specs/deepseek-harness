#!/bin/sh
# dsh-headless-runtime 入口：按环境变量生成 $DSH_HOME/settings.yaml 后转交 dsh。
# 与项目 .env 对齐的变量：DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL_NAME
set -e

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$DSH_HOME"

BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com}"
MODEL="${DEEPSEEK_MODEL_NAME:-deepseek-chat}"

# 注意：chat-completions 协议请求 {baseURL}/chat/completions，
# 因此 DEEPSEEK_BASE_URL 需包含 /v1（如 https://dashscope.aliyuncs.com/compatible-mode/v1）。
cat > "$DSH_HOME/settings.yaml" <<EOF
llm-deepseek:
  baseURL: ${BASE_URL}
  protocol: chat-completions
  apiKeyEnv: DEEPSEEK_API_KEY
  models:
    - id: ${MODEL}
      name: ${MODEL}
      contextWindow: 1000000
      inputModalities:
        - text
agent-default-model:
  provider: deepseek-official
  model: ${MODEL}
EOF

exec dsh "$@"
