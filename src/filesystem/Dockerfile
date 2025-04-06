# Build stage
FROM node:22.12-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

COPY src/filesystem /app
COPY tsconfig.json /tsconfig.json

RUN --mount=type=cache,target=/root/.npm npm install

RUN --mount=type=cache,target=/root/.npm-production npm ci --ignore-scripts --omit-dev

# Build the TypeScript code
RUN npm run build

# Release stage
FROM node:22-alpine AS release

WORKDIR /app

# Install Dart SDK
RUN apk add --no-cache \
    bash \
    curl \
    git

# Install Dart SDK
RUN curl -fsSL https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/dartsdk-linux-x64-release.zip -o dart.zip && \
    unzip dart.zip -d /usr/local && \
    rm dart.zip

# Add Dart to PATH
ENV PATH="/usr/local/dart-sdk/bin:${PATH}"

# Install Go
RUN apk add --no-cache go

# Install Python and pipx using apk
RUN apk update && \
    apk add --no-cache python3 pipx && \
    # Use pipx to install black in an isolated environment
    pipx install black
    # Optional: pipx ensurepath # This might be useful, but setting ENV is more explicit in Docker


# Install Prettier via npm
RUN npm install -g prettier

# Copy the built application
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json

# Set production environment
ENV NODE_ENV=production

# Install production dependencies
RUN npm ci --ignore-scripts --omit-dev

# Print installed versions for verification
RUN echo "Node version: $(node -v)" && \
    echo "Dart version: $(dart --version)" && \
    echo "Go version: $(go version)" && \
    echo "Python version: $(python3 --version)" && \
    echo "Black version: $(black --version)" && \
    echo "Prettier version: $(prettier --version)"

# Set entrypoint
ENTRYPOINT ["node", "/app/dist/index.js"]