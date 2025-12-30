const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class BaileysPairingService {
  constructor() {
    this.activePairings = new Map();
    this.sessionsBasePath = path.join(__dirname, '../sessions');
  }

  getSessionPath(userEmail, botId) {
    return path.join(this.sessionsBasePath, userEmail, botId);
  }

  async generatePairingCode(phoneNumber, userEmail, botId) {
    const sessionPath = this.getSessionPath(userEmail, botId);
    
    try {
      // Créer le répertoire de session
      await fs.mkdir(sessionPath, { recursive: true });
      
      // Sauvegarder les infos de session
      const sessionInfo = {
        userEmail,
        botId,
        phoneNumber,
        startedAt: new Date().toISOString(),
        status: 'pairing',
        attempts: 0
      };
      
      await fs.writeFile(
        path.join(sessionPath, 'session_info.json'),
        JSON.stringify(sessionInfo, null, 2)
      );

      logger.info(`Starting pairing process for ${phoneNumber}, bot: ${botId}`);

      // Initialiser Baileys
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        logger: { level: 'silent' }
      });

      // Sauvegarder les credentials
      sock.ev.on('creds.update', saveCreds);

      return new Promise((resolve, reject) => {
        const pairingKey = `${userEmail}_${botId}`;
        let pairingResolved = false;
        
        // Timeout après 2 minutes
        const timeout = setTimeout(() => {
          if (!pairingResolved) {
            pairingResolved = true;
            this.activePairings.delete(pairingKey);
            sock.end();
            reject(new Error('Pairing timeout (2 minutes)'));
          }
        }, 120000);

        // Gérer les événements de connexion
        sock.ev.on('connection.update', async (update) => {
          const { connection, qr } = update;
          
          if (connection === 'open') {
            logger.info(`WhatsApp connected for ${phoneNumber}, bot: ${botId}`);
            
            if (!pairingResolved) {
              pairingResolved = true;
              clearTimeout(timeout);
              
              // Mettre à jour les infos de session
              sessionInfo.status = 'connected';
              sessionInfo.connectedAt = new Date().toISOString();
              sessionInfo.sessionId = sock.user?.id;
              
              await fs.writeFile(
                path.join(sessionPath, 'session_info.json'),
                JSON.stringify(sessionInfo, null, 2)
              );
              
              // Fermer le socket après la connexion
              setTimeout(() => {
                sock.end();
              }, 3000);
              
              this.activePairings.delete(pairingKey);
              resolve('CONNECTED');
            }
          }
          
          if (connection === 'close') {
            logger.warn(`WhatsApp disconnected for ${phoneNumber}, bot: ${botId}`);
            
            if (!pairingResolved) {
              pairingResolved = true;
              clearTimeout(timeout);
              this.activePairings.delete(pairingKey);
              reject(new Error('Connection closed during pairing'));
            }
          }
        });

        // Demander le code de pairing
        (async () => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            logger.info(`Pairing code generated for ${phoneNumber}: ${code}`);
            
            if (!pairingResolved) {
              pairingResolved = true;
              clearTimeout(timeout);
              
              // Stocker temporairement la socket pour la connexion
              this.activePairings.set(pairingKey, sock);
              resolve(code);
            }
          } catch (pairError) {
            logger.error(`Pairing error for ${phoneNumber}:`, pairError);
            
            if (!pairingResolved) {
              pairingResolved = true;
              clearTimeout(timeout);
              this.activePairings.delete(pairingKey);
              
              // Supprimer la session échouée
              try {
                await fs.rm(sessionPath, { recursive: true, force: true });
              } catch (cleanupError) {
                logger.error('Failed to cleanup session:', cleanupError);
              }
              
              reject(pairError);
            }
          }
        })();
      });

    } catch (error) {
      logger.error('Pairing service error:', error);
      
      // Nettoyer en cas d'erreur
      try {
        await fs.rm(sessionPath, { recursive: true, force: true });
      } catch {}
      
      throw error;
    }
  }

  async checkSessionStatus(userEmail, botId) {
    const sessionPath = this.getSessionPath(userEmail, botId);
    
    try {
      await fs.access(sessionPath);
      
      // Vérifier les fichiers de session
      const files = await fs.readdir(sessionPath);
      
      // Vérifier la présence de fichiers de credentials
      const hasCreds = files.some(file => 
        file.includes('creds') && file.endsWith('.json')
      );
      
      if (!hasCreds) {
        return { exists: true, connected: false, reason: 'no_creds' };
      }
      
      // Lire les infos de session
      let sessionInfo = {};
      try {
        const infoData = await fs.readFile(
          path.join(sessionPath, 'session_info.json'),
          'utf8'
        );
        sessionInfo = JSON.parse(infoData);
      } catch {}
      
      // Vérifier si la session est marquée comme connectée
      const isConnected = sessionInfo.status === 'connected';
      
      return {
        exists: true,
        connected: isConnected,
        sessionInfo: sessionInfo,
        files: files
      };
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { exists: false, connected: false, reason: 'no_directory' };
      }
      throw error;
    }
  }

  async getSessionInfo(userEmail, botId) {
    const sessionPath = this.getSessionPath(userEmail, botId);
    
    try {
      const infoPath = path.join(sessionPath, 'session_info.json');
      const data = await fs.readFile(infoPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  async deleteSession(userEmail, botId) {
    const sessionPath = this.getSessionPath(userEmail, botId);
    
    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
      logger.info(`Session deleted for ${userEmail}, bot: ${botId}`);
      return true;
    } catch (error) {
      logger.error('Failed to delete session:', error);
      return false;
    }
  }

  // Vérifier périodiquement l'état des sessions
  async checkAllSessions() {
    try {
      const users = await fs.readdir(this.sessionsBasePath);
      const results = [];
      
      for (const userEmail of users) {
        const userPath = path.join(this.sessionsBasePath, userEmail);
        const stats = await fs.stat(userPath);
        
        if (stats.isDirectory()) {
          const bots = await fs.readdir(userPath);
          
          for (const botId of bots) {
            const status = await this.checkSessionStatus(userEmail, botId);
            results.push({
              userEmail,
              botId,
              ...status
            });
          }
        }
      }
      
      return results;
    } catch (error) {
      logger.error('Error checking all sessions:', error);
      return [];
    }
  }
}

module.exports = new BaileysPairingService();
