FROM node:20-bullseye

# Instalar TODAS as dependências do Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    chromium \
    chromium-sandbox \
    && rm -rf /var/lib/apt/lists/*

# Criar symlink para garantir que Chromium está em /usr/bin/chromium
RUN if [ ! -f /usr/bin/chromium ]; then \
      ln -s /usr/bin/chromium-browser /usr/bin/chromium || \
      ln -s $(which chromium) /usr/bin/chromium || \
      echo "Warning: Chromium not found"; \
    fi

# Verificar instalação do Chromium
RUN which chromium || which chromium-browser || echo "CHROMIUM NOT FOUND!" && \
    ls -la /usr/bin/chromium* || echo "No chromium in /usr/bin"

# Configurar Puppeteer para NÃO baixar Chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium

WORKDIR /app

# Copiar package files e instalar dependências
COPY package*.json ./
COPY .npmrc ./
RUN npm ci --omit=dev

# Remover qualquer cache do Puppeteer que possa existir
RUN rm -rf /root/.cache/puppeteer || true

COPY . .

# Criar diretórios necessários
RUN mkdir -p /app/tokens /app/sessions

EXPOSE 8080

CMD ["node", "server.js"]
