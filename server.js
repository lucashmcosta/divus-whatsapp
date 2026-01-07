const express = require('express');
const wppconnect = require('@wppconnect-team/wppconnect');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load environment variables
try {
  require('dotenv').config();
} catch (err) {
  console.log('⚠️  .env file not found (this is OK in production)');
}

// Configuração do diretório de sessões persistentes (Railway Volume)
const VOLUME_BASE = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const SESSION_DIR = path.join(VOLUME_BASE, 'wpp-tokens');

// Garantir que o diretório de sessões exista
try {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    console.log(`📁 Created session directory: ${SESSION_DIR}`);
  } else {
    console.log(`📁 Session directory exists: ${SESSION_DIR}`);
  }
  // Verificar permissões de escrita
  fs.accessSync(SESSION_DIR, fs.constants.W_OK);
  console.log(`✅ Session directory is writable`);
} catch (err) {
  console.error(`❌ Error setting up session directory: ${err.message}`);
  console.error(`⚠️  Sessions may not persist across restarts!`);
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

// Armazenar clientes ativos, QR codes e webhooks
const clients = new Map();
const qrCodes = new Map();
const webhooks = new Map();

// Função para enviar mensagem para webhook com retry
async function sendToWebhook(session, data, retries = 3) {
  const webhookUrl = webhooks.get(session);
  if (!webhookUrl) return;

  const payload = JSON.stringify({
    session,
    ...data,
    timestamp: Date.now()
  });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: payload,
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.ok) {
        console.log(`✅ Webhook sent for ${session}: ${data.type || 'message'}`);
        return; // Sucesso, sair
      }

      console.error(`❌ Webhook error for ${session}: ${response.status} (attempt ${attempt}/${retries})`);
    } catch (error) {
      console.error(`❌ Webhook failed for ${session}: ${error.message} (attempt ${attempt}/${retries})`);
    }

    // Aguardar antes de retry (backoff exponencial: 1s, 2s, 4s)
    if (attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }

  console.error(`❌ Webhook permanently failed for ${session} after ${retries} attempts`);
}

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
    chromium_path: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    session_storage: SESSION_DIR
  });
});

// 1. CONECTAR - Iniciar Sessão
app.post('/api/:session/start-session', authenticate, async (req, res) => {
  const { session } = req.params;
  const { webhook, waitQrCode } = req.body;

  try {
    console.log(`🚀 Starting session: ${session}`);

    // Verificar se já existe cliente ativo
    if (clients.has(session)) {
      const client = clients.get(session);
      try {
        const isConnected = await client.isConnected();
        console.log(`♻️ Session ${session} already exists, connected: ${isConnected}`);

        if (isConnected) {
          return res.json({
            success: true,
            message: 'Session already connected',
            status: 'connected',
            session,
            qrCode: null
          });
        } else if (qrCodes.has(session)) {
          return res.json({
            success: true,
            message: 'Session exists with QR code',
            status: 'qrcode',
            session,
            qrCode: qrCodes.get(session)
          });
        }
      } catch (err) {
        // Se der erro ao verificar, remove e recria
        console.log(`🗑️ Removing stale session: ${session} (error: ${err?.message || 'unknown'})`);
        try {
          await client.close();
        } catch (closeErr) {
          console.log(`⚠️ Error closing stale client: ${closeErr?.message || 'unknown'}`);
        }
        clients.delete(session);
        qrCodes.delete(session);
      }
    }

    // Verificar tokens existentes no diretório persistente
    const tokenPath = path.join(SESSION_DIR, session);

    if (fs.existsSync(tokenPath)) {
      try {
        console.log(`📁 Found existing session data for ${session} in ${tokenPath}`);
        const files = fs.readdirSync(tokenPath);
        console.log(`📁 Found ${files.length} files in token directory`);
      } catch (fsErr) {
        console.log(`⚠️ Error reading token directory: ${fsErr?.message || 'unknown'}`);
      }
    } else {
      console.log(`📁 No existing session data for ${session}, will create new`);
    }

    let qrCode = null;
    let sessionStatus = 'initializing';
    let clientCreated = false;
    let createError = null;

    console.log(`📱 Creating WPPConnect client for: ${session}`);
    console.log(`🌍 Environment: NODE_ENV=${process.env.NODE_ENV}`);
    console.log(`🌐 Chromium path: ${process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'}`);
    console.log(`⏳ Creating WPPConnect client (this may take 10-20s)...`);

    const createClientPromise = wppconnect.create({
      session: session,
      folderNameToken: SESSION_DIR, // Salvar tokens no volume persistente
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
      autoClose: 0, // Desabilitado - não fechar automaticamente durante SYNCING
      createPathFileToken: true,
      waitForLogin: true, // Aguardar login completo
      // Desabilitar Phone Watchdog para evitar "Phone not connected" durante SYNCING
      phoneAutoClose: 0,
      checkTimeout: 60000, // Aumentar timeout de verificação para 60s
      // Desabilitar verificações que podem causar desconexão prematura
      linkPreviewApiServers: null,
      puppeteerOptions: {
        // Limitar memória e processos
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          // Otimizações de memória para Railway
          '--single-process',
          '--no-zygote',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--disable-hang-monitor',
          '--disable-prompt-on-repost',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-domain-reliability',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--js-flags=--max-old-space-size=256'
        ]
      },
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        // Otimizações de memória para Railway
        '--single-process',
        '--no-zygote',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-features=AudioServiceOutOfProcess',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--js-flags=--max-old-space-size=256'
      ]
    });

    // Salvar webhook se fornecido
    if (webhook) {
      webhooks.set(session, webhook);
      console.log(`🔗 Webhook registered for ${session}: ${webhook}`);
    }

    // Salvar o cliente quando estiver pronto (em background)
    createClientPromise
      .then(client => {
        clients.set(session, client);
        clientCreated = true;
        console.log(`✅ Client fully initialized for ${session}`);

        // Registrar listener para mensagens recebidas
        client.onMessage(async (message) => {
          console.log(`📩 New message for ${session} from ${message.from}: ${message.body?.substring(0, 50) || '[media]'}`);

          await sendToWebhook(session, {
            type: 'message',
            event: 'onMessage',
            message: {
              id: message.id,
              from: message.from,
              to: message.to,
              body: message.body,
              type: message.type,
              timestamp: message.timestamp,
              isGroupMsg: message.isGroupMsg,
              sender: message.sender,
              notifyName: message.notifyName,
              quotedMsg: message.quotedMsg,
              mimetype: message.mimetype,
              caption: message.caption
            }
          });
        });

        // Listener para mensagens enviadas (confirmação)
        client.onAck(async (ack) => {
          await sendToWebhook(session, {
            type: 'ack',
            event: 'onAck',
            ack: {
              id: ack.id,
              chatId: ack.chatId,
              status: ack.ack
            }
          });
        });

        // Listener para chamadas de voz/vídeo recebidas
        client.onIncomingCall(async (call) => {
          console.log(`📞 Incoming call for ${session} from ${call.peerJid}: ${call.isVideo ? 'VIDEO' : 'AUDIO'}`);

          await sendToWebhook(session, {
            type: 'call',
            event: 'onIncomingCall',
            call: {
              id: call.id,
              peerJid: call.peerJid,
              isVideo: call.isVideo,
              isGroup: call.isGroup,
              offerTime: call.offerTime,
              sender: call.peerJid
            }
          });
        });

        // Listener para mudança de estado da conexão
        client.onStateChange(async (state) => {
          console.log(`🔄 State changed for ${session}: ${state}`);

          await sendToWebhook(session, {
            type: 'state',
            event: 'onStateChange',
            state: state
          });
        });

        console.log(`👂 All listeners registered for ${session} (messages, calls, state)`);
      })
      .catch(err => {
        // Capturar TODOS os detalhes do erro
        createError = err;
        console.error(`❌ Error creating client for ${session}:`);
        console.error('Error type:', typeof err);
        console.error('Error value:', err);
        console.error('Error message:', err?.message || 'no message');
        console.error('Error stack:', err?.stack || 'no stack');
        console.error('Error toString:', err ? String(err) : 'err is falsy');

        clients.delete(session);
        qrCodes.delete(session);
      });

    // Aguardar APENAS o QR code (não o cliente completo)
    if (waitQrCode) {
      console.log(`⏳ Waiting for QR code generation (up to 30s)...`);
      const qrTimeout = 30000; // 30 segundos para QR aparecer
      const start = Date.now();

      while (!qrCode && !createError && (Date.now() - start) < qrTimeout) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Verificar se houve erro durante a criação
      if (createError) {
        console.error(`❌ Client creation failed, aborting`);
        throw new Error(
          createError?.message ||
          createError?.toString?.() ||
          'Failed to create WhatsApp client - unknown error'
        );
      }

      if (qrCode) {
        console.log(`✅ QR code ready for ${session}, returning to client`);
      } else {
        console.log(`⚠️ QR code not generated within 30s for ${session}`);
        console.log(`⚠️ Client created: ${clientCreated}, Has error: ${!!createError}`);
        throw new Error('QR code generation timeout - the server may be overloaded, please try again');
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

// 6. ENVIAR IMAGEM
app.post('/api/:session/send-image', authenticate, async (req, res) => {
  const { session } = req.params;
  const { phone, base64, filename, caption } = req.body;

  if (!phone || !base64) {
    return res.status(400).json({
      success: false,
      error: 'Missing phone or base64 image'
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

    const phoneNumber = phone.includes('@') ? phone : `${phone}@c.us`;
    console.log(`🖼️ Sending image to ${phoneNumber} from ${session}`);

    const result = await client.sendImage(phoneNumber, base64, filename || 'image', caption || '');

    res.json({
      success: true,
      result,
      session,
      to: phoneNumber,
      message: 'Image sent successfully'
    });
  } catch (error) {
    console.error(`Send image error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 7. ENVIAR ARQUIVO/DOCUMENTO
app.post('/api/:session/send-file', authenticate, async (req, res) => {
  const { session } = req.params;
  const { phone, base64, filename, caption } = req.body;

  if (!phone || !base64 || !filename) {
    return res.status(400).json({
      success: false,
      error: 'Missing phone, base64 or filename'
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

    const phoneNumber = phone.includes('@') ? phone : `${phone}@c.us`;
    console.log(`📎 Sending file to ${phoneNumber} from ${session}`);

    const result = await client.sendFile(phoneNumber, base64, filename, caption || '');

    res.json({
      success: true,
      result,
      session,
      to: phoneNumber,
      message: 'File sent successfully'
    });
  } catch (error) {
    console.error(`Send file error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 8. ENVIAR ÁUDIO (VOZ)
app.post('/api/:session/send-voice', authenticate, async (req, res) => {
  const { session } = req.params;
  const { phone, base64 } = req.body;

  if (!phone || !base64) {
    return res.status(400).json({
      success: false,
      error: 'Missing phone or base64 audio'
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

    const phoneNumber = phone.includes('@') ? phone : `${phone}@c.us`;
    console.log(`🎤 Sending voice to ${phoneNumber} from ${session}`);

    const result = await client.sendPtt(phoneNumber, base64);

    res.json({
      success: true,
      result,
      session,
      to: phoneNumber,
      message: 'Voice message sent successfully'
    });
  } catch (error) {
    console.error(`Send voice error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 9. ENVIAR VÍDEO
app.post('/api/:session/send-video', authenticate, async (req, res) => {
  const { session } = req.params;
  const { phone, base64, filename, caption } = req.body;

  if (!phone || !base64) {
    return res.status(400).json({
      success: false,
      error: 'Missing phone or base64 video'
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

    const phoneNumber = phone.includes('@') ? phone : `${phone}@c.us`;
    console.log(`🎬 Sending video to ${phoneNumber} from ${session}`);

    const result = await client.sendVideoAsGif(phoneNumber, base64, filename || 'video', caption || '');

    res.json({
      success: true,
      result,
      session,
      to: phoneNumber,
      message: 'Video sent successfully'
    });
  } catch (error) {
    console.error(`Send video error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 10. BUSCAR MENSAGENS DE UM CHAT
app.get('/api/:session/get-messages/:phone', authenticate, async (req, res) => {
  const { session, phone } = req.params;
  const { isGroup, includeMe, includeNotifications } = req.query;

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

    // Formatar o número do telefone
    let chatId = phone;
    if (!phone.includes('@')) {
      chatId = isGroup === 'true' ? `${phone}@g.us` : `${phone}@c.us`;
    }

    console.log(`📨 Getting messages from ${chatId} for session ${session}`);

    // Usar getAllMessagesInChat (mais estável)
    const messages = await client.getAllMessagesInChat(
      chatId,
      includeMe !== 'false',
      includeNotifications === 'true'
    );

    res.json({
      success: true,
      session,
      chatId,
      count: messages?.length || 0,
      messages: messages || []
    });
  } catch (error) {
    console.error(`Get messages error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 11. CARREGAR E BUSCAR TODAS AS MENSAGENS DE UM CHAT
app.get('/api/:session/all-messages-in-chat/:phone', authenticate, async (req, res) => {
  const { session, phone } = req.params;
  const { isGroup, includeMe, includeNotifications } = req.query;

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

    // Formatar o número do telefone
    let chatId = phone;
    if (!phone.includes('@')) {
      chatId = isGroup === 'true' ? `${phone}@g.us` : `${phone}@c.us`;
    }

    console.log(`📨 Loading all messages from ${chatId} for session ${session}`);

    // Usar getAllMessagesInChat (loadAndGetAllMessagesInChat está com bug)
    const messages = await client.getAllMessagesInChat(
      chatId,
      includeMe !== 'false',
      includeNotifications === 'true'
    );

    res.json({
      success: true,
      session,
      chatId,
      count: messages?.length || 0,
      messages: messages || []
    });
  } catch (error) {
    console.error(`Load all messages error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 12. CARREGAR MENSAGENS DE UM CHAT (load-messages-in-chat)
app.get('/api/:session/load-messages-in-chat/:phone', authenticate, async (req, res) => {
  const { session, phone } = req.params;
  const { isGroup, includeMe, includeNotifications } = req.query;

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

    // Formatar o número do telefone
    let chatId = phone;
    if (!phone.includes('@')) {
      chatId = isGroup === 'true' ? `${phone}@g.us` : `${phone}@c.us`;
    }

    console.log(`📨 Loading messages from ${chatId} for session ${session}`);

    // Usar getAllMessagesInChat (loadAndGetAllMessagesInChat está com bug)
    const messages = await client.getAllMessagesInChat(
      chatId,
      includeMe !== 'false',
      includeNotifications === 'true'
    );

    res.json({
      success: true,
      session,
      chatId,
      count: messages?.length || 0,
      messages: messages || []
    });
  } catch (error) {
    console.error(`Load messages error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 9. CONFIGURAR WEBHOOK
app.post('/api/:session/webhook', authenticate, async (req, res) => {
  const { session } = req.params;
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'Missing webhook URL'
    });
  }

  webhooks.set(session, url);
  console.log(`🔗 Webhook updated for ${session}: ${url}`);

  res.json({
    success: true,
    session,
    webhook: url,
    message: 'Webhook configured successfully'
  });
});

// 10. REMOVER WEBHOOK
app.delete('/api/:session/webhook', authenticate, async (req, res) => {
  const { session } = req.params;

  webhooks.delete(session);
  console.log(`🔗 Webhook removed for ${session}`);

  res.json({
    success: true,
    session,
    message: 'Webhook removed successfully'
  });
});

// 11. LISTAR SESSÕES
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
  console.log(`💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used`);
  console.log(`📂 Session storage: ${SESSION_DIR}\n`);
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