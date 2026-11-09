FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
RUN test "$(node --version)" = v24.22.1 && command -v Xvfb
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src/ ./src/
COPY schemas/ ./schemas/
COPY scripts/ ./scripts/
COPY extensions/ ./extensions/
COPY test/ ./test/
COPY tsconfig.json tsconfig.build.json tsconfig.test.json ./
RUN npm run build
RUN mkdir -p /catalog /run/work /reports /workspace/.vscode-test && chown 1000:1000 /catalog /run/work /reports /workspace/.vscode-test
USER 1000:1000
ENTRYPOINT ["xvfb-run", "-a", "node", "/workspace/test/integration/backstage/lib/driver.mjs"]
