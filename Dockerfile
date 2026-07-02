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
# ffmpeg : assemblage du ciné MP4 de la série (compte rendu confrère).
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV HUSKY=0
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
# Install complet (pas --prod) : le bundle serveur importe statiquement `vite` (devDep).
RUN pnpm install --frozen-lockfile
COPY --from=builder /app/dist ./dist
# Migrations + drizzle config so `pnpm db:migrate` can run inside the image.
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY tsconfig.json ./
# Sécurité : utilisateur non-root (audit H1).
RUN addgroup -S mediview && adduser -S mediview -G mediview \
    && chown -R mediview:mediview /app
USER mediview
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
