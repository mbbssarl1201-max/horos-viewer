FROM node:22-alpine AS builder
WORKDIR /app
ENV HUSKY=0
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS production
WORKDIR /app
ENV HUSKY=0
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
# Install complet (pas --prod) : le bundle serveur importe statiquement `vite` (devDep).
RUN pnpm install --frozen-lockfile
COPY --from=builder /app/dist ./dist
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
