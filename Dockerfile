FROM oven/bun:1.1.18-alpine AS base

FROM base AS builder

WORKDIR /app

COPY package.json bun.lockb* ./

RUN bun install --frozen-lockfile

# Copy the rest of the application code
COPY . .

# Build the application
RUN bun run build

FROM base AS production

COPY --from=builder /app/dist /app/dist

WORKDIR /app
# Specify the command to run the application
CMD ["bun", "run", "dist/index.js"]