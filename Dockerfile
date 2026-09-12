FROM node:22-slim AS build-client
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
# API calls go to the same origin the backend serves from - no separate host needed
RUN echo "VITE_API_BASE=" > .env
RUN npm run build

FROM node:22-slim
WORKDIR /app

COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

COPY server/ ./server/
COPY --from=build-client /app/client/dist ./client/dist

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/index.js"]
