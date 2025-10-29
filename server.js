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

// Armazenar clientes ativos
const clients = new Map();

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

// Criar/Iniciar Sessão
app.post('/api/:session/start', authenticate, async (req, res) => {
  const { session } = req.params;
  
  try {
    if (clients.has(session)) {
      return res.json({ 
        success: false,
        message: 'Session already exists',
        status: 'active'
      });
    }

    let qrCode = null;
    let sessionStatus = 'initializing';

    console.log(`Creating session: ${session}`);

    const client = await wppconnect.create({
      session: session,
      catchQR: (base64Qr) => {
        qrCode = base64Qr;
        sessionStatus = 'qrcode';
        console.log(`QR Code generated for ${session}`);
      },
      statusFind: (status) => {
        sessionStatus = status;
        console.log(`Status ${session}:`, status);
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

    // Aguardar QR Code
    await new Promise(resolve => setTimeout(resolve, 8000));

    res.json({
      success: true,
      session: session,
      qrCode: qrCode,
      status: sessionStatus,
      message: 'Session created'
    });

  } catch (error) {
    console.error(`Error creating session ${session}:`, error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Status da Sessão
app.get('/api/:session/status', authenticate, async (req, res) => {
  const { session } = req.params;
  const client = clients.get(session);

  if (!client) {
    return res.status(404).json({ 
      success: false,
      status: 'not_found' 
    });
  }

  try {
    const state = await client.getConnectionState();
    const isConnected = await client.isConnected();
    
    res.json({
      success: true,
      session: session,
      status: isConnected ? 'connected' : 'disconnected',
      state: state
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Fechar Sessão
app.post('/api/:session/close', authenticate, async (req, res) => {
  const { session } = req.params;
  const client = clients.get(session);

  if (!client) {
    return res.status(404).json({ 
      success: false,
      error: 'Session not found' 
    });
  }

  try {
    await client.close();
    clients.delete(session);
    
    res.json({ 
      success: true,
      message: 'Session closed' 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Enviar Mensagem
app.post('/api/:session/send-message', authenticate, async (req, res) => {
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
    const phoneNumber = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    const result = await client.sendText(phoneNumber, message);
    
    res.json({ 
      success: true,
      result: result 
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Listar Sessões Ativas
app.get('/api/sessions', authenticate, (req, res) => {
  const sessions = Array.from(clients.keys()).map(name => ({
    name,
    status: 'active'
  }));

  res.json({
    success: true,
    count: sessions.length,
    sessions: sessions
  });
});

// ==================== SERVIDOR ====================

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔑 API Key configured: ${API_KEY.substring(0, 8)}...`);
  console.log(`📊 Active sessions: ${clients.size}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing sessions...');
  
  for (const [name, client] of clients.entries()) {
    try {
      await client.close();
      console.log(`Session ${name} closed`);
    } catch (error) {
      console.error(`Error closing ${name}:`, error);
    }
  }
  
  process.exit(0);
});
