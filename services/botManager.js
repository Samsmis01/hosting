const { spawn, exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const simpleGit = require('simple-git');
const { db } = require('../database');
const logger = require('../utils/logger');

class BotManager {
  constructor() {
    this.activeProcesses = new Map();
    this.deployments = new Map();
    this.monitoringInterval = null;
  }

  // Démarrer la surveillance des bots
  startMonitoring(interval = 30000) {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    this.monitoringInterval = setInterval(async () => {
      await this.monitorActiveBots();
    }, interval);

    logger.info(`Bot monitoring started (interval: ${interval}ms)`);
  }

  // Surveiller les bots actifs
  async monitorActiveBots() {
    try {
      const bots = await db.getAllBots();
      const onlineBots = bots.filter(bot => bot.status === 'online' && bot.pid);

      for (const bot of onlineBots) {
        const processInfo = this.getProcessInfo(bot.id);
        
        if (!processInfo || !processInfo.running) {
          logger.warn(`Bot ${bot.id} (${bot.name}) is marked as online but process not found`);
          
          // Mettre à jour le statut
          await db.updateBot(bot.id, {
            status: 'offline',
            pid: null,
            lastCheck: new Date().toISOString()
          });
        }
      }

      // Vérifier les bots en attente de déploiement
      const pendingBots = bots.filter(bot => 
        bot.status === 'pending' && 
        bot.phoneNumber && 
        !bot.pid
      );

      for (const bot of pendingBots) {
        // Vérifier si une session existe
        const baileysPairing = require('./baileysPairing');
        const sessionStatus = await baileysPairing.checkSessionStatus(
          bot.owner,
          bot.id
        );

        if (sessionStatus.connected) {
          logger.info(`Auto-deploying bot ${bot.id} (${bot.name}) with existing session`);
          await this.deployBot(bot);
        }
      }

    } catch (error) {
      logger.error('Bot monitoring error:', error);
    }
  }

  // Déployer un bot
  async deployBot(bot) {
    try {
      const deployDir = path.join(__dirname, '../deployments', bot.owner, bot.id);
      
      logger.info(`Starting deployment for bot ${bot.id} (${bot.name})`);

      // Nettoyer l'ancien déploiement
      try {
        await fs.rm(deployDir, { recursive: true, force: true });
      } catch {}

      // Créer le répertoire
      await fs.mkdir(deployDir, { recursive: true });

      // Cloner le dépôt
      logger.info(`Cloning ${bot.githubRepo} to ${deployDir}`);
      const git = simpleGit();
      await git.clone(bot.githubRepo, deployDir);

      // Vérifier package.json
      const packagePath = path.join(deployDir, 'package.json');
      let hasPackage = false;

      try {
        await fs.access(packagePath);
        hasPackage = true;
        
        // Installer les dépendances
        logger.info(`Installing dependencies for ${bot.name}`);
        await this.runCommand('npm install', deployDir);
      } catch {
        logger.info(`No package.json found for ${bot.name}, skipping npm install`);
      }

      // Trouver le fichier principal
      const mainFile = await this.findMainFile(deployDir);
      if (!mainFile) {
        throw new Error('No main bot file found');
      }

      logger.info(`Found main file: ${mainFile} for ${bot.name}`);

      // Charger la configuration
      const config = await this.loadBotConfig(bot.owner, bot.id);

      // Démarrer le bot
      const botProcess = spawn('node', [mainFile], {
        cwd: deployDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BOT_OWNER: bot.owner,
          BOT_NAME: bot.name,
          BOT_ID: bot.id,
          WHATSAPP_NUMBER: bot.phoneNumber || '',
          SESSION_PATH: path.join(__dirname, '../sessions', bot.owner, bot.id),
          CONFIG_PATH: path.join(__dirname, '../configs', bot.owner, bot.id, 'config.json'),
          NODE_ENV: 'production',
          PORT: process.env.BOT_PORT || '3001',
          LOG_LEVEL: 'info'
        },
        detached: true
      });

      // Stocker les informations du processus
      const processInfo = {
        process: botProcess,
        pid: botProcess.pid,
        startTime: new Date(),
        logs: [],
        status: 'running',
        botId: bot.id,
        botName: bot.name
      };

      this.activeProcesses.set(bot.id, processInfo);
      this.deployments.set(bot.id, deployDir);

      // Capturer les logs
      botProcess.stdout.on('data', (data) => {
        const log = data.toString().trim();
        if (log) {
          this.addLog(bot.id, log);
          logger.info(`Bot ${bot.name}: ${log}`);
        }
      });

      botProcess.stderr.on('data', (data) => {
        const log = data.toString().trim();
        if (log) {
          this.addLog(bot.id, `ERROR: ${log}`);
          logger.error(`Bot ${bot.name}: ${log}`);
        }
      });

      botProcess.on('close', async (code) => {
        logger.info(`Bot ${bot.name} exited with code ${code}`);
        
        const info = this.activeProcesses.get(bot.id);
        if (info) {
          info.status = 'stopped';
          info.exitCode = code;
          info.endTime = new Date();
        }
        
        // Mettre à jour la base de données
        await db.updateBot(bot.id, {
          status: code === 0 ? 'offline' : 'error',
          exitCode: code,
          lastStop: new Date().toISOString(),
          pid: null
        });
        
        this.activeProcesses.delete(bot.id);
      });

      // Attendre un peu pour vérifier le démarrage
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Vérifier si le processus est toujours en cours
      if (botProcess.exitCode !== null) {
        throw new Error(`Bot process failed to start, exit code: ${botProcess.exitCode}`);
      }

      logger.info(`Bot ${bot.name} deployed successfully with PID ${botProcess.pid}`);

      return {
        success: true,
        pid: botProcess.pid,
        deployDir: deployDir,
        mainFile: mainFile,
        hasPackage: hasPackage,
        botId: bot.id
      };

    } catch (error) {
      logger.error(`Deployment failed for bot ${bot.id}:`, error);
      
      await db.updateBot(bot.id, {
        status: 'error',
        error: error.message,
        lastError: new Date().toISOString()
      });

      return {
        success: false,
        error: error.message,
        botId: bot.id
      };
    }
  }

  // Arrêter un bot
  stopBot(botId) {
    const processInfo = this.activeProcesses.get(botId);
    
    if (processInfo && processInfo.process) {
      try {
        processInfo.process.kill('SIGTERM');
        processInfo.status = 'stopping';
        
        // Forcer l'arrêt après 5 secondes
        setTimeout(() => {
          if (processInfo.process.exitCode === null) {
            processInfo.process.kill('SIGKILL');
          }
        }, 5000);
        
        logger.info(`Stopped bot ${botId} (PID: ${processInfo.pid})`);
        return true;
      } catch (error) {
        logger.error(`Failed to stop bot ${botId}:`, error);
        return false;
      }
    }
    
    return false;
  }

  // Obtenir les informations d'un processus
  getProcessInfo(botId) {
    const processInfo = this.activeProcesses.get(botId);
    
    if (!processInfo) {
      return null;
    }
    
    return {
      pid: processInfo.pid,
      running: processInfo.status === 'running',
      startTime: processInfo.startTime,
      uptime: Date.now() - processInfo.startTime.getTime(),
      logs: processInfo.logs.slice(-10),
      status: processInfo.status
    };
  }

  // Méthodes utilitaires
  async runCommand(command, cwd) {
    return new Promise((resolve, reject) => {
      exec(command, { cwd }, (error, stdout, stderr) => {
        if (error) {
          logger.error(`Command error (${command}):`, stderr);
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }

  async findMainFile(deployDir) {
    const possibleFiles = ['index.js', 'main.js', 'app.js', 'bot.js', 'start.js'];
    
    for (const file of possibleFiles) {
      try {
        await fs.access(path.join(deployDir, file));
        return file;
      } catch {}
    }
    
    // Chercher n'importe quel fichier .js
    try {
      const files = await fs.readdir(deployDir);
      const jsFiles = files.filter(f => 
        f.endsWith('.js') && 
        !f.includes('test') && 
        !f.includes('spec')
      );
      
      if (jsFiles.length > 0) {
        return jsFiles[0];
      }
    } catch {}
    
    return null;
  }

  async loadBotConfig(userEmail, botId) {
    try {
      const configPath = path.join(__dirname, '../configs', userEmail, botId, 'config.json');
      const configData = await fs.readFile(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      // Configuration par défaut
      return {
        owner: userEmail,
        online: true,
        autotype: true,
        fakerecord: false,
        prefix: '!',
        welcomeMessage: 'Bienvenue sur le bot!',
        goodbyeMessage: 'Au revoir!'
      };
    }
  }

  addLog(botId, message) {
    const processInfo = this.activeProcesses.get(botId);
    
    if (processInfo) {
      processInfo.logs.push({
        timestamp: new Date().toISOString(),
        message: message
      });
      
      // Garder seulement les 100 derniers logs
      if (processInfo.logs.length > 100) {
        processInfo.logs.shift();
      }
      
      // Mettre à jour dans la base de données périodiquement
      if (processInfo.logs.length % 10 === 0) {
        db.updateBot(botId, {
          logs: processInfo.logs.slice(-50)
        }).catch(err => logger.error('Failed to update bot logs:', err));
      }
    }
  }

  // Obtenir tous les processus actifs
  getAllActiveProcesses() {
    const processes = [];
    
    for (const [botId, info] of this.activeProcesses) {
      processes.push({
        botId: botId,
        botName: info.botName,
        pid: info.pid,
        status: info.status,
        uptime: Date.now() - info.startTime.getTime(),
        startTime: info.startTime
      });
    }
    
    return processes;
  }
}

// Exporter une instance singleton
const botManager = new BotManager();

// Exporter aussi la classe pour les tests
module.exports = {
  botManager,
  BotManager,
  startMonitoring: () => botManager.startMonitoring(),
  deployBot: (bot) => botManager.deployBot(bot),
  stopBot: (botId) => botManager.stopBot(botId),
  getProcessInfo: (botId) => botManager.getProcessInfo(botId),
  getAllActiveProcesses: () => botManager.getAllActiveProcesses()
};
