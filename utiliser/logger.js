const winston = require('winston');
const path = require('path');
const fs = require('fs').promises;

// Créer le répertoire de logs
const logsDir = path.join(__dirname, '../logs');

// Format personnalisé pour les logs
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Format console
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(
    ({ level, message, timestamp, ...metadata }) => {
      let msg = `${timestamp} [${level}] : ${message} `;
      
      if (Object.keys(metadata).length > 0) {
        msg += JSON.stringify(metadata);
      }
      
      return msg;
    }
  )
);

// Créer le logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    // Console
    new winston.transports.Console({
      format: consoleFormat
    }),
    
    // Fichier général
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // Fichier d'erreurs
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5
    }),
    
    // Fichier d'accès HTTP
    new winston.transports.File({
      filename: path.join(logsDir, 'access.log'),
      maxsize: 5242880,
      maxFiles: 10
    })
  ]
});

// Fonction pour initialiser les logs
async function initializeLogger() {
  try {
    await fs.mkdir(logsDir, { recursive: true });
    logger.info('Logger initialized successfully');
  } catch (error) {
    console.error('Failed to initialize logger:', error);
  }
}

// Exporter le logger et la fonction d'initialisation
module.exports = logger;
module.exports.initializeLogger = initializeLogger;
