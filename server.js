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

// Health Check
app.get('/', (req, res) => {
  res.json({ 
    status: 'online',
    sessions: clients.size,
    message: 'WPPConnect Server - Divus Legal',
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Rota de ready check para Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// 1. CONECTAR - Iniciar Sessão
app.post('/api/:session/start-session', authenticate, async (req, res) => {
  const { session } = req.params;
  const { webhook, waitQrCode } = req.body;
  
  try {
    if (clients.has(session)) {
      const client = clients.get(session);
      const isConnected = await client.isConnected();
      
      return res.json({ 
        success: true,
        message: 'Session already exists',
        status: isConnected ? 'connected' : 'qrcode',
        session,
        qrCode: qrCodes.get(session) || null
      });
    }

    let qrCode = null;
    let sessionStatus = 'initializing';

    console.log(`🚀 Starting session: ${session}`);

    const client = await wppconnect.create({
      session: session,
      catchQR: (base64Qr) => {
        qrCode = base64Qr;
        qrCodes.set(session, base64Qr);
        sessionStatus = 'qrcode';
        console.log(`📱 QR Code generated for ${session}`);
      },
      statusFind: (status) => {
        console.log(`📊 Status ${session}:`, status);
        sessionStatus = status;
        
        if (status === 'authenticated' || status === 'isLogged') {
          sessionStatus = 'connected';
          qrCodes.delete(session);
          console.log(`✅ ${session} connected`);
        }
      },
      headless: true,
      devtools: false,
      useChrome: true,
      debug: false,
      logQR: false,
      disableWelcome: true,
      updatesLog: false,
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

    if (waitQrCode) {
      const maxWait = 12000;
      const startTime = Date.now();
      
      while (!qrCode && (Date.now() - startTime) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    res.json({
      success: true,
      session: session,
      qrCode: qrCode,
      status: sessionStatus,
      message: qrCode ? 'QR Code generated' : 'Session started',
      webhook: webhook || null
    });

  } catch (error) {
    console.error(`❌ Error starting session ${session}:`, error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// 2. OBTER QR CODE
app.get('/api/:session/qrcode', authenticate, async (req, res) => {
  const { session } = req.params;
  const qrCode = qrCodes.get(session);
  
  if (!qrCode) {
    return res.status(404).json({ 
      success: false,
      error: 'QR Code not available'
    });
  }

  res.json({
    success: true,
    session: session,
    qrCode: qrCode
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
      session: session,
      connected: false
    });
  }

  try {
    const isConnected = await client.isConnected();
    
    res.json({
      success: true,
      session: session,
      status: isConnected ? 'connected' : 'notLogged',
      connected: isConnected
    });
  } catch (error) {
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
    await client.logout();
    await client.close();
    clients.delete(session);
    qrCodes.delete(session);
    
    res.json({ 
      success: true,
      message: 'Logged out',
      session: session
    });
  } catch (error) {
    console.error(`Error logout ${session}:`, error);
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
    console.log(`💬 Sending to ${phoneNumber}`);
    
    const result = await client.sendText(phoneNumber, message);
    
    res.json({ 
      success: true,
      result: result,
      session: session,
      to: phoneNumber
    });
  } catch (error) {
    console.error(`Error sending:`, error);
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
    } catch (error) {
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
    sessions: sessions
  });
});

// ==================== SERVIDOR ====================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY.substring(0, 8)}...`);
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n⚠️  ${signal} received, shutting down gracefully...`);
  
  server.close(() => {
    console.log('🔌 HTTP server closed');
  });

  for (const [name, client] of clients.entries()) {
    try {
      await client.close();
      console.log(`✅ ${name} closed`);
    } catch (error) {
      console.error(`❌ Error closing ${name}:`, error);
    }
  }
  
  clients.clear();
  qrCodes.clear();
  
  if (pool) {
    await pool.end();
  }
  
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
