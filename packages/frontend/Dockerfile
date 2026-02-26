# VAEB Frontend Dockerfile
# React + Vite Frontend Application

FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
COPY packages/frontend/package*.json ./packages/frontend/

# Install dependencies (force linux platform for cross-compatibility)
RUN rm -f package-lock.json && npm install --workspace=@vaeb/frontend --include-workspace-root --force && \
    npm install @rollup/rollup-linux-arm64-musl --save-dev --workspace=@vaeb/frontend --force 2>/dev/null || true

# Copy source code
COPY packages/frontend ./packages/frontend

# Build the frontend
RUN npm run build --workspace=@vaeb/frontend

# Production stage with nginx
FROM nginx:alpine AS production

# Copy built files to nginx
COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html

# Copy nginx configuration
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
