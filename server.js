const express = require('express');
const wppconnect = require('@wppconnect-team/wppconnect');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');

// Load environment variables
try {
  require('dotenv').config();
} catch (err) {
  console.log('⚠️  .env file not found (this is OK in production)');
}

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'change-me';

// Validate critical configurations
if (!API_KEY || API_KEY === 'change-me') {
  console.warn('⚠️  WARNING: API_KEY not set or using default value!');
  console.warn('⚠️  Please set API_KEY environment variable for security!');
}

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL Pool (opcional)
const pool = (process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) ? new Pool({
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
    timestamp: new Date().toISOString(),
    node_version: process.version,
    platform: process.platform
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    sessions: clients.size,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    chromium_path: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
  });
});

// 1. CONECTAR - Iniciar Sessão
app.post('/api/:session/start-session', authenticate, async (req, res) => {
  const { session } = req.params;
  const { webhook, waitQrCode } = req.body;

  try {
    console.log(`🚀 Starting session: ${session}`);

    // Verificar se já existe
    if (clients.has(session)) {
      const client = clients.get(session);
      try {
        const isConnected = await client.isConnected();
        console.log(`♻️ Session ${session} already exists, connected: ${isConnected}`);
        return res.json({
          success: true,
          message: 'Session already exists',
          status: isConnected ? 'connected' : 'qrcode',
          session,
          qrCode: qrCodes.get(session) || null
        });
      } catch (err) {
        // Se der erro ao verificar, remove e recria
        console.log(`🗑️ Removing stale session: ${session}`);
        clients.delete(session);
        qrCodes.delete(session);
      }
    }

    let qrCode = null;
    let sessionStatus = 'initializing';
    let clientCreated = false;

    console.log(`📱 Creating WPPConnect client for: ${session}`);
    console.log(`🌍 Environment: NODE_ENV=${process.env.NODE_ENV}`);
    console.log(`🌐 Chromium path: ${process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'}`);

    // Criar cliente em background e aguardar QR code
    console.log(`⏳ Creating WPPConnect client (this may take 10-20s)...`);

    const createClientPromise = wppconnect.create({
      session: session,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      catchQR: (base64Qr) => {
        qrCode = base64Qr;
        qrCodes.set(session, base64Qr);
        sessionStatus = 'qrcode';
        console.log(`✅ QR code generated for ${session}`);
      },
      statusFind: (status) => {
        console.log(`📊 ${session} status changed: ${status}`);
        sessionStatus = status;

        if (status === 'authenticated' || status === 'isLogged') {
          sessionStatus = 'connected';
          qrCodes.delete(session);
          console.log(`✅ ${session} authenticated successfully`);
        }
      },
      headless: true,
      devtools: false,
      useChrome: false,
      debug: false,
      logQR: false,
      disableWelcome: true,
      updatesLog: false,
      autoClose: 300000, // 5 minutos - dar tempo para escanear QR
      createPathFileToken: true,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions'
      ]
    });

    // Salvar o cliente quando estiver pronto (em background)
    createClientPromise
      .then(client => {
        clients.set(session, client);
        clientCreated = true;
        console.log(`✅ Client fully initialized for ${session}`);
      })
      .catch(err => {
        console.error(`❌ Error creating client for ${session}:`, err.message);
        clients.delete(session);
        qrCodes.delete(session);
      });

    // Aguardar APENAS o QR code (não o cliente completo)
    if (waitQrCode) {
      console.log(`⏳ Waiting for QR code generation (up to 30s)...`);
      const qrTimeout = 30000; // 30 segundos para QR aparecer
      const start = Date.now();

      while (!qrCode && (Date.now() - start) < qrTimeout) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (qrCode) {
        console.log(`✅ QR code ready for ${session}, returning to client`);
      } else {
        console.log(`⚠️ QR code not generated within 30s for ${session}`);
        throw new Error('QR code generation timeout - please try again');
      }
    }

    // Retornar imediatamente após QR code estar disponível
    res.json({
      success: true,
      session,
      qrCode,
      status: sessionStatus,
      message: qrCode ? 'QR Code ready - scan to connect' : 'Session starting',
      webhook: webhook || null
    });

  } catch (error) {
    console.error(`❌ Error creating session ${session}:`);
    console.error(`Error message: ${error.message}`);
    console.error(`Error stack: ${error.stack}`);

    // Limpar se falhou
    clients.delete(session);
    qrCodes.delete(session);

    res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack,
      session
    });
  }
});

// 2. OBTER QR CODE
app.get('/api/:session/qrcode', authenticate, async (req, res) => {
  const { session } = req.params;

  console.log(`📱 QR code request for session: ${session}`);

  const client = clients.get(session);
  const qrCode = qrCodes.get(session);

  // Verificar se está conectado
  if (client) {
    try {
      const isConnected = await client.isConnected();
      if (isConnected) {
        console.log(`✅ Session ${session} is already connected`);
        return res.json({
          success: true,
          session,
          connected: true,
          status: 'connected',
          qrCode: null,
          message: 'Session already connected'
        });
      }
    } catch (err) {
      console.error(`Error checking connection status: ${err.message}`);
    }
  }

  if (!qrCode) {
    console.log(`⚠️ QR code not available for session: ${session}`);
    return res.status(404).json({
      success: false,
      error: 'QR Code not available',
      message: 'Session may be connected or not started',
      connected: false
    });
  }

  console.log(`✅ Returning QR code for session: ${session}`);
  res.json({
    success: true,
    session,
    qrCode,
    connected: false,
    status: 'qrcode'
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

// Verificar Chromium na inicialização
const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
console.log(`\n🔍 Checking Chromium installation...`);
console.log(`📍 Chromium path: ${chromiumPath}`);

try {
  if (fs.existsSync(chromiumPath)) {
    console.log(`✅ Chromium found at ${chromiumPath}`);
  } else {
    console.warn(`⚠️  WARNING: Chromium not found at ${chromiumPath}`);
    console.warn(`⚠️  This may cause errors when creating sessions!`);
  }
} catch (err) {
  console.error(`❌ Error checking Chromium: ${err.message}`);
}

let isShuttingDown = false;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`🔑 API Key configured`);
  console.log(`🌐 Ready to accept connections`);
  console.log(`📦 Node version: ${process.version}`);
  console.log(`💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used\n`);
});

// Timeout maior para o servidor (3 minutos para permitir criação do cliente)
server.timeout = 180000; // 3 minutos
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

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
  console.error('Stack trace:', error.stack);
  console.error('Error type:', typeof error);
  console.error('Error details:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
});

console.log('🚀 WPPConnect Server initialized');