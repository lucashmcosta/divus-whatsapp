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
    message: 'WPPConnect Server - Divus Legal'
  });
});

// 1. CONECTAR - Iniciar Sessão (chamado pelo Lovable)
app.post('/api/:session/start-session', authenticate, async (req, res) => {
  const { session } = req.params;
  const { webhook, waitQrCode } = req.body;
  
  try {
    // Se já existe, retorna info da sessão
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
        
        // Limpar QR code quando conectado
        if (status === 'authenticated' || status === 'isLogged') {
          sessionStatus = 'connected';
          qrCodes.delete(session);
          console.log(`✅ ${session} connected successfully`);
        }
      },
      headless: true,
      devtools: false,
      useChrome: true,
      debug: false,
      logQR: false,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });

    // Salvar cliente
    clients.set(session, client);

    // Se waitQrCode é true, aguarda o QR Code ser gerado
    if (waitQrCode) {
      const maxWait = 15000; // 15 segundos
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

// 2. OBTER QR CODE (chamado pelo Lovable)
app.get('/api/:session/qrcode', authenticate, async (req, res) => {
  const { session } = req.params;
  
  // Verifica se tem QR code armazenado
  const qrCode = qrCodes.get(session);
  
  if (!qrCode) {
    return res.status(404).json({ 
      success: false,
      error: 'QR Code not available',
      message: 'Session may be already connected or not started'
    });
  }

  res.json({
    success: true,
    session: session,
    qrCode: qrCode,
    message: 'QR Code retrieved'
  });
});

// 3. STATUS DA SESSÃO (chamado pelo Lovable)
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
    const state = await client.getConnectionState();
    
    res.json({
      success: true,
      session: session,
      status: isConnected ? 'connected' : 'notLogged',
      state: state,
      connected: isConnected
    });
  } catch (error) {
    console.error(`Error checking status ${session}:`, error);
    res.json({ 
      success: false,
      status: 'error',
      error: error.message,
      connected: false
    });
  }
});

// 4. LOGOUT/DESCONECTAR (chamado pelo Lovable)
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
    console.log(`🔌 Logging out session: ${session}`);
    await client.logout();
    await client.close();
    clients.delete(session);
    qrCodes.delete(session);
    
    res.json({ 
      success: true,
      message: 'Session logged out successfully',
      session: session
    });
  } catch (error) {
    console.error(`Error logging out ${session}:`, error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// 5. ENVIAR MENSAGEM (chamado pelo Lovable)
app.post('/api/:session/sendText', authenticate, async (req, res) => {
  const { session } = req.params;
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing required fields',
      required: { phone: 'string', message: 'string' }
    });
  }

  const client = clients.get(session);

  if (!client) {
    return res.status(404).json({ 
      success: false,
      error: 'Session not found. Please start session first.' 
    });
  }

  try {
    const isConnected = await client.isConnected();
    
    if (!isConnected) {
      return res.status(400).json({
        success: false,
        error: 'Session not connected',
        message: 'Please reconnect the session'
      });
    }

    // Formatar número para WhatsApp
    const phoneNumber = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    
    console.log(`💬 Sending message to ${phoneNumber} from ${session}`);
    
    const result = await client.sendText(phoneNumber, message);
    
    res.json({ 
      success: true,
      result: result,
      session: session,
      to: phoneNumber,
      message: 'Message sent successfully'
    });
  } catch (error) {
    console.error(`Error sending message from ${session}:`, error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// 6. LISTAR SESSÕES ATIVAS
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

// ==================== ROTAS DE COMPATIBILIDADE ====================

// Alias para rotas antigas (manter compatibilidade)
app.post('/api/:session/start', authenticate, async (req, res) => {
  req.body = { ...req.body, waitQrCode: true };
  return app._router.handle(req, res, () => {});
});

app.post('/api/:session/send-message', authenticate, async (req, res) => {
  return app._router.handle(req, res, () => {});
});

app.post('/api/:session/close', authenticate, async (req, res) => {
  return app._router.handle(req, res, () => {});
});

// ==================== SERVIDOR ====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ WPPConnect Server running on port ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY.substring(0, 8)}...`);
  console.log(`📊 Active sessions: ${clients.size}`);
  console.log(`🌐 Health check: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('⚠️  SIGTERM received, closing sessions...');
  
  for (const [name, client] of clients.entries()) {
    try {
      await client.close();
      console.log(`✅ Session ${name} closed`);
    } catch (error) {
      console.error(`❌ Error closing ${name}:`, error);
    }
  }
  
  clients.clear();
  qrCodes.clear();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('⚠️  SIGINT received, closing sessions...');
  
  for (const [name, client] of clients.entries()) {
    try {
      await client.close();
      console.log(`✅ Session ${name} closed`);
    } catch (error) {
      console.error(`❌ Error closing ${name}:`, error);
    }
  }
  
  clients.clear();
  qrCodes.clear();
  process.exit(0);
});
