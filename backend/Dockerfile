FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to copy files and adjust permissions
USER root

WORKDIR /app

# Tell Puppeteer to skip downloading Chrome and use the installed one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application
COPY . .

# Ensure correct permissions
RUN chown -R pptruser:pptruser /app

# Switch back to the non-privileged user
USER pptruser

# Expose the port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]
