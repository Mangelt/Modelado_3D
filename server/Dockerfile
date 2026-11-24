FROM node:20-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/ ./
RUN mkdir -p /app/.secrets && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 CMD node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
