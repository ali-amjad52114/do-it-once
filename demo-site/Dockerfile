FROM node:24-slim
WORKDIR /app
COPY server.mjs qr.mjs ./
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["node", "server.mjs"]
