# 前端镜像 —— 跑的是 Vite dev server（带热更新），不是生产静态构建产物。
# docker-compose.yml 把源码目录挂载进容器（见其 volumes），这个镜像只负责提供
# Node 运行时 + 预装好的 node_modules，改代码不用重建镜像。生产环境不用这个镜像：
# `npm run build` 出静态文件，交给 nginx/CDN 或塞进后端的 StaticFiles 挂载即可。
FROM node:20-slim

WORKDIR /app

# 依赖单独一层：package.json 没变时改代码不用重装。
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

EXPOSE 5173

# vite.config.js 里 server.host:true 已经绑定 0.0.0.0，不需要额外传 --host。
CMD ["npm", "run", "dev"]
