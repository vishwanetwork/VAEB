# VAEB Server Dockerfile
# Backend API Server for intent review and execution

FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy all package.json files first (for better caching)
COPY package*.json ./
COPY packages/server/package*.json ./packages/server/
COPY packages/mcp-server/package*.json ./packages/mcp-server/
COPY packages/intent-sdk/package*.json ./packages/intent-sdk/
COPY packages/canton-settlement/package*.json ./packages/canton-settlement/

# Install all dependencies (use npm install for cross-platform compatibility)
RUN npm install --include-workspace-root

# Copy source code
COPY packages/server ./packages/server
COPY packages/mcp-server ./packages/mcp-server
COPY packages/intent-sdk ./packages/intent-sdk
COPY packages/canton-settlement ./packages/canton-settlement
COPY contracts ./contracts
COPY scripts ./scripts

# Build all dependent packages in order
RUN npm run build --workspace=@vaeb/intent-sdk && \
    npm run build --workspace=@vaeb/canton-settlement && \
    npm run build --workspace=@vaeb/mcp-server && \
    npm run build --workspace=@vaeb/server

# Production stage
FROM node:20-slim AS production

WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install production dependencies
COPY package*.json ./
COPY packages/server/package*.json ./packages/server/
COPY packages/mcp-server/package*.json ./packages/mcp-server/
COPY packages/intent-sdk/package*.json ./packages/intent-sdk/
COPY packages/canton-settlement/package*.json ./packages/canton-settlement/
RUN npm install --include-workspace-root --omit=dev

# Copy built files
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=builder /app/packages/intent-sdk/dist ./packages/intent-sdk/dist
COPY --from=builder /app/packages/canton-settlement/dist ./packages/canton-settlement/dist
COPY --from=builder /app/contracts ./contracts
COPY --from=builder /app/scripts ./scripts

# Expose port
EXPOSE 13002

WORKDIR /app/packages/server

CMD ["node", "dist/index.js"]
