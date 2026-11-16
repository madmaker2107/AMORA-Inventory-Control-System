# ==============================================================================
# AMORA Backend - Production Container Definition
# ==============================================================================
# Multi-stage Docker build optimized for Debian Slim and native SQLite compilation
# ==============================================================================

# Stage 1: Build native dependencies (better-sqlite3)
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install native compilation dependencies for C++ addons
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY backend/package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Stage 2: Minimal runtime image
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Set production environment defaults
ENV NODE_ENV=production \
    PORT=4016 \
    DATABASE_PATH=/app/data/amora.sqlite

# Create dedicated non-root application user
RUN groupadd -r amora && useradd -r -g amora -m amora

# Copy production node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY backend/package*.json ./
COPY backend/server.js ./
COPY backend/provision-firebase-user.js ./

# Prepare persistent data directory with non-root ownership
RUN mkdir -p /app/data && chown -R amora:amora /app

# Switch to non-root user
USER amora

# Expose backend service port
EXPOSE 4016

# Built-in health check using Node native fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:' + (process.env.PORT || 4016) + '/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the AMORA Express server
CMD ["node", "server.js"]
