const express = require('express');
const wppconnect = require('@wppconnect-team/wppconnect');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'change-me';

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL Pool (opcional)
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

// Armazenar clientes ativos e QR codes
const clients = new Map();
const qrCodes = new Map();

// Auth Middleware
const authenticate = (req, res, next) => {
  const key = req.headers['authorization']?.replace('Bearer ', '') || 
                req.headers['x-api-key'];
  
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ==================== ROTAS ====================

// Health Check (IMPORTANTE: Railway precisa disso)
app.get('/', (req, res) => {
  res.json({ 
    status: 'online',
    sessions: clients.size,
    message: 'WPPConnect Server - Divus Legal',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    uptime: process.uptime()
  });
});

// 1. CONECTAR - Iniciar Sessão
app.post('/api/:session/start-session', authenticate, async (req, res) => {
  const { session } = req.params;
  const { webhook, waitQrCode } = req.body;
  
  try {
    // Verificar se já existe
    if (clients.has(session)) {
      const client = clients.get(session);
      try {
        const isConnected = await client.isConnected();
        return res.json({ 
          success: true,
          message: 'Session already exists',
          status: isConnected ? 'connected' : 'qrcode',
          session,
          qrCode: qrCodes.get(session) || null
        });
      } catch (err) {
        // Se der erro ao verificar, remove e recria
        console.log(`Removing stale session: ${session}`);
        clients.delete(session);
        qrCodes.delete(session);
      }
    }

    let qrCode = null;
    let sessionStatus = 'initializing';

    console.log(`🚀 Creating session: ${session}`);

    // Criar cliente com configuração otimizada
const client = await wppconnect.create({
  session: session,
  // ADICIONE ESTA LINHA:
  executablePath: '/usr/bin/chromium',
  catchQR: (base64Qr) => {
    qrCode = base64Qr;
    qrCodes.set(session, base64Qr);
    sessionStatus = 'qrcode';
    console.log(`📱 QR generated for ${session}`);
  },
  statusFind: (status) => {
    console.log(`📊 ${session} status: ${status}`);
    sessionStatus = status;
    
    if (status === 'authenticated' || status === 'isLogged') {
      sessionStatus = 'connected';
      qrCodes.delete(session);
      console.log(`✅ ${session} authenticated`);
    }
  },
  headless: true,
  devtools: false,
  useChrome: false, // MUDE PARA FALSE
  debug: false,
  logQR: false,
  disableWelcome: true,
  updatesLog: false,
  autoClose: 60000,
  createPathFileToken: true,
  browserArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu'
  ]
});

    clients.set(session, client);

    // Aguardar QR code se solicitado
    if (waitQrCode) {
      const timeout = 10000; // 10 segundos
      const start = Date.now();
      
      while (!qrCode && (Date.now() - start) < timeout) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    res.json({
      success: true,
      session,
      qrCode,
      status: sessionStatus,
      message: qrCode ? 'QR Code ready' : 'Session starting',
      webhook: webhook || null
    });

  } catch (error) {
    console.error(`❌ Error creating ${session}:`, error.message);
    
    // Limpar se falhou
    clients.delete(session);
    qrCodes.delete(session);
    
    res.status(500).json({ 
      success: false,
      error: error.message,
      session
    });
  }
});

// 2. OBTER QR CODE
app.get('/api/:session/qrcode', authenticate, (req, res) => {
  const { session } = req.params;
  const qrCode = qrCodes.get(session);
  
  if (!qrCode) {
    return res.status(404).json({ 
      success: false,
      error: 'QR Code not available',
      message: 'Session may be connected or not started'
    });
  }

  res.json({
    success: true,
    session,
    qrCode
  });
});

// 3. STATUS DA SESSÃO
app.get('/api/:session/status', authenticate, async (req, res) => {
  const { session } = req.params;
  const client = clients.get(session);

  if (!client) {
    return res.json({ 
      success: false,
      status: 'notLogged',
      session,
      connected: false
    });
  }

  try {
    const isConnected = await Promise.race([
      client.isConnected(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
    
    res.json({
      success: true,
      session,
      status: isConnected ? 'connected' : 'notLogged',
      connected: isConnected
    });
  } catch (error) {
    console.error(`Status check error for ${session}:`, error.message);
    res.json({ 
      success: false,
      status: 'error',
      error: error.message,
      connected: false
    });
  }
});

// 4. LOGOUT
app.post('/api/:session/logout', authenticate, async (req, res) => {
  const { session } = req.params;
  const client = clients.get(session);

  if (!client) {
    return res.status(404).json({ 
      success: false,
      error: 'Session not found' 
    });
  }

  try {
    console.log(`🔌 Logging out: ${session}`);
    
    await Promise.race([
      client.logout(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Logout timeout')), 5000))
    ]);
    
    await client.close();
    clients.delete(session);
    qrCodes.delete(session);
    
    res.json({ 
      success: true,
      message: 'Logged out successfully',
      session
    });
  } catch (error) {
    console.error(`Logout error for ${session}:`, error.message);
    
    // Força remoção mesmo com erro
    clients.delete(session);
    qrCodes.delete(session);
    
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// 5. ENVIAR MENSAGEM
app.post('/api/:session/sendText', authenticate, async (req, res) => {
  const { session } = req.params;
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing phone or message'
    });
  }

  const client = clients.get(session);

  if (!client) {
    return res.status(404).json({ 
      success: false,
      error: 'Session not found' 
    });
  }

  try {
    const isConnected = await client.isConnected();
    
    if (!isConnected) {
      return res.status(400).json({
        success: false,
        error: 'Session not connected'
      });
    }

    const phoneNumber = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    console.log(`💬 Sending to ${phoneNumber} from ${session}`);
    
    const result = await client.sendText(phoneNumber, message);
    
    res.json({ 
      success: true,
      result,
      session,
      to: phoneNumber,
      message: 'Sent successfully'
    });
  } catch (error) {
    console.error(`Send error:`, error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// 6. LISTAR SESSÕES
app.get('/api/sessions', authenticate, async (req, res) => {
  const sessions = [];
  
  for (const [name, client] of clients.entries()) {
    try {
      const isConnected = await client.isConnected();
      sessions.push({
        name,
        status: isConnected ? 'connected' : 'disconnected',
        connected: isConnected
      });
    } catch {
      sessions.push({
        name,
        status: 'error',
        connected: false
      });
    }
  }

  res.json({
    success: true,
    count: sessions.length,
    sessions
  });
});

// ==================== SERVIDOR ====================

let isShuttingDown = false;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔑 API Key configured`);
  console.log(`🌐 Ready to accept connections`);
});

// Timeout maior para o servidor
server.timeout = 120000; // 2 minutos

// Graceful shutdown
const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`\n⚠️  ${signal} - Shutting down...`);
  
  // Para de aceitar novas conexões
  server.close(() => {
    console.log('🔌 Server closed');
  });

  // Fecha todas as sessões
  const closePromises = [];
  for (const [name, client] of clients.entries()) {
    closePromises.push(
      client.close()
        .then(() => console.log(`✅ Closed ${name}`))
        .catch(err => console.error(`❌ Error closing ${name}:`, err.message))
    );
  }

  await Promise.allSettled(closePromises);
  
  clients.clear();
  qrCodes.clear();
  
  if (pool) {
    await pool.end();
  }
  
  console.log('👋 Goodbye!');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

console.log('🚀 WPPConnect Server initialized');
```

## Configurações no Railway

1. **Adicione estas variáveis de ambiente:**
```
API_KEY=sua_chave_aqui
PORT=8080
NODE_ENV=production
