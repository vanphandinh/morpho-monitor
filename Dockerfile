FROM node:22-alpine

WORKDIR /app

# Copy dependency files first (layer caching)
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application code
COPY *.mjs ./
COPY *.html ./
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh
RUN mkdir -p /app/data

# Webapp + proxy ports
EXPOSE 3000
EXPOSE 8545

ENTRYPOINT ["./docker-entrypoint.sh"]
