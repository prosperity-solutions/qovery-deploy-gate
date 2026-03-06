FROM node:24.14.0-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npm ci
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build && cp -r src/generated dist/

FROM node:24.14.0-alpine
LABEL org.opencontainers.image.description="qovery-deploy-gate API server and web dashboard — coordinates synchronized traffic cutover for multi-service deployments on Qovery"
WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
