FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN node scripts/compile.mjs
EXPOSE 8080
CMD ["node", "scripts/serve.mjs", "8080"]
