FROM node:20-slim

# Instalar dependências do Chrome
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
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
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package files
COPY package*.json ./

# Instalar dependências
RUN npm ci --production

# Copiar código
COPY . .

# Criar diretório para tokens
RUN mkdir -p /app/tokens

# Expor porta
EXPOSE 8080

# Iniciar servidor
CMD ["node", "server.js"]
```

## Estrutura do projeto:
```
seu-projeto/
├── server.js
├── package.json
├── .env (não commitar)
├── Dockerfile (escolha este OU nixpacks.toml)
└── nixpacks.toml (escolha este OU Dockerfile)
