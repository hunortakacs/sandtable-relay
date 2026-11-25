FROM node:22-alpine
# Node 25+ no longer ships corepack, which installs the pnpm that package.json names.
# renovate: datasource=npm depName=corepack
ARG COREPACK_VERSION=0.36.0
RUN npm install --global corepack@${COREPACK_VERSION} && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY server.js ./

# Bound to loopback on the host by the compose port mapping; TLS and the public
# hostname are Caddy's job.
ENV PORT=8090
EXPOSE 8090

CMD ["node", "server.js"]
