# VAEB Prover Service Dockerfile
# ZK Prover Service - Groth16 proof generation

FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy root package files
COPY package*.json ./
COPY packages/prover-service/package*.json ./packages/prover-service/

# Install dependencies (use npm install for cross-platform compatibility)
RUN npm install --workspace=@vaeb/prover-service --include-workspace-root

# Copy source code
COPY packages/prover-service ./packages/prover-service
COPY circuits ./circuits

# Build the service
RUN npm run build --workspace=@vaeb/prover-service

# Production stage
FROM node:20-slim AS production

WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install production dependencies only
COPY package*.json ./
COPY packages/prover-service/package*.json ./packages/prover-service/
RUN npm install --workspace=@vaeb/prover-service --include-workspace-root --omit=dev

# Copy built files
COPY --from=builder /app/packages/prover-service/dist ./packages/prover-service/dist
COPY --from=builder /app/circuits ./circuits

# Expose port
EXPOSE 13001

WORKDIR /app/packages/prover-service

CMD ["node", "dist/index.js"]
