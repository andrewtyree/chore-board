# Minimal, dependency-free image. Node 20 Alpine, runs as non-root.
FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=8080 DATA_FILE=/data/state.json
VOLUME ["/data"]
EXPOSE 8080
USER node
CMD ["node", "server.js"]
