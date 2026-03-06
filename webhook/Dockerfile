FROM node:24.14.0-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

FROM node:24.14.0-alpine
WORKDIR /app
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
USER 1000:1000
EXPOSE 8443
CMD ["node", "dist/index.js"]
