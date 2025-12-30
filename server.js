require('express-async-errors');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs').promises;

// Utils
const logger = require('./utils/logger');
const { initializeDatabase } = require('./database');

// Middleware
const { authenticateToken } = require('./middleware/auth');

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const adsRoutes = require('./routes/ads');
const deployRoutes = require('./routes/deploy');
const pairingRoutes = require('./routes/pairing');
const configRoutes = require('./routes/config');

const app = express();
const PORT = process.env.PORT || 3000;

// Créer les répertoires nécessaires
async function setupDirectories() {
  const dirs = [
    'sessions',
    'configs',
    'deployments',
    'logs',
    'public',
    'public/assets',
    path.join(__dirname, 'database', 'data')
  ];

  for (const dir of dirs) {
    try {
      await fs.mkdir(path.join(__dirname, dir), { recursive: true });
      logger.info(`Directory created/verified: ${dir}`);
    } catch (error) {
      logger.error(`Failed to create directory ${dir}:`, error);
    }
  }
}

// Configuration sécurité
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"]
    }
  }
}));

// CORS configuré pour Railway
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Logging
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.http(message.trim())
  }
}));

// Compression
app.use(compression());

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));
app.use('/sessions', express.static(path.join(__dirname, 'sessions')));
app.use('/configs', express.static(path.join(__dirname, 'configs')));

// Routes API
app.use('/api/auth', authRoutes);
app.use('/api/user', authenticateToken, userRoutes);
app.use('/api/admin', authenticateToken, require('./middleware/admin'), adminRoutes);
app.use('/api/ads', authenticateToken, adsRoutes);
app.use('/api/deploy', authenticateToken, deployRoutes);
app.use('/api/pairing', authenticateToken, pairingRoutes);
app.use('/api/config', authenticateToken, configRoutes);

// Routes HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

app.get('/pair', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pair.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health check pour Railway
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV,
    service: 'HEXTECH Backend'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Démarrer le serveur
async function startServer() {
  try {
    await setupDirectories();
    await initializeDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 HEXTECH Backend started on port ${PORT}`);
      logger.info(`🌐 Environment: ${process.env.NODE_ENV}`);
      logger.info(`📊 Admin: ${process.env.ADMIN_EMAIL}`);
      logger.info(`🔗 Health check: http://localhost:${PORT}/api/health`);
      
      // Démarrer le gestionnaire de bots
      require('./services/botManager').startMonitoring();
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Gestion des signaux pour un arrêt propre
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

startServer();
