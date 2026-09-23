FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

# Bound to loopback on the host by the compose port mapping; TLS and the public
# hostname are Caddy's job.
ENV PORT=8090
EXPOSE 8090

CMD ["node", "server.js"]
