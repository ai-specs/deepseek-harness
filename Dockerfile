# dsh(PC) 运行时镜像——开发模式容器
FROM node:24-slim
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
COPY apps apps
RUN CI=true pnpm install --frozen-lockfile 2>/dev/null || pnpm install
COPY . .
RUN CI=true pnpm run build 2>/dev/null || echo "build skipped"
EXPOSE 3000
CMD ["pnpm", "dsh", "web", "--port", "3000"]
