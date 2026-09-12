ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM dependencies AS test
COPY lib ./lib
COPY server.mjs hosted.mjs ./
COPY assets ./assets
COPY web ./web
COPY extensions ./extensions
COPY scripts ./scripts
COPY test ./test
COPY mail-code-dashboard.html design-system.html mail-forward.config.example.json ./
CMD ["node", "--test", "test/*.test.mjs"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data MASTER_KEY_FILE=/run/secrets/master-key
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY lib ./lib
COPY hosted.mjs ./
COPY web ./web
COPY scripts/hosted-init.mjs ./scripts/hosted-init.mjs
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "hosted.mjs"]
