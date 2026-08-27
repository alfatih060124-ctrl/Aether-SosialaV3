FROM node:20-alpine
WORKDIR /app
COPY services/api/package.json ./services/api/package.json
RUN cd services/api && npm install --omit=dev
COPY services/api/src ./services/api/src
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "services/api/src/server.mjs"]
