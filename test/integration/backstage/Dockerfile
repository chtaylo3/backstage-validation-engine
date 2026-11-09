FROM node:24.22.1-bookworm-slim@sha256:e1582112fb9f152ed38eefcd712efc93fee1becb519fdfa57574d5e07eaa5e7d AS tools
RUN apt-get update && apt-get install -y --no-install-recommends python3 g++ make ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN rm /usr/local/bin/yarn /usr/local/bin/yarnpkg && npm install --global --ignore-scripts --no-audit --no-fund @yarnpkg/cli-dist@4.13.0
ENV YARN_ENABLE_TELEMETRY=0
WORKDIR /app

FROM tools AS application
ARG APP_TARGET
COPY apps/${APP_TARGET}/ ./
RUN yarn install --immutable
RUN yarn build:app
COPY app-config.test.yaml ./app-config.test.yaml
COPY targets.json ./test-targets.json
COPY lib/app-metadata.mjs ./app-metadata.mjs
RUN mkdir -p /state /catalog && chown node:node /state /catalog
USER node
EXPOSE 7007
CMD ["yarn", "start"]
