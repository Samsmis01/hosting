const express = require('express');
const router = express.Router();
const { db } = require('../database');
const botManager = require('../services/botManager');
const logger = require('../utils/logger');
const { validateBotDeployment } = require('../utils/validators');

// Déployer un nouveau bot
router.post('/deploy', async (req, res) => {
  try {
    const { botName, githubRepo, description, cost } = req.body;
    const user = req.user;

    // Validation
    const validation = validateBotDeployment({
      botName,
      githubRepo,
      description,
      cost,
      userPoints: user.points,
      userRole: user.role
    });

    if (!validation.valid) {
      return res.status(400).json({ error: validation.message });
    }

    // Vérifier si l'utilisateur a déjà un bot avec ce nom
    const userBots = await db.getBotsByOwner(user.email);
    const existingBot = userBots.find(bot => bot.name === botName);
    
    if (existingBot) {
      return res.status(400).json({ 
        error: 'You already have a bot with this name',
        botId: existingBot.id
      });
    }

    logger.info(`Starting deployment for ${botName} by ${user.email}`);

    // Créer l'entrée du bot
    const bot = await db.createBot({
      name: botName,
      description: description || `WhatsApp bot ${botName}`,
      githubRepo: githubRepo,
      cost: cost || 10,
      owner: user.email,
      status: 'pending'
    });

    // Déduire les points (sauf admin)
    if (user.role !== 'admin') {
      const newPoints = user.points - cost;
      await db.updateUser(user.email, { points: newPoints });

      await db.addPointsLog({
        user: user.email,
        action: 'bot_deployment',
        pointsChange: -cost,
        description: `Deployed bot: ${botName}`,
        newBalance: newPoints,
        botId: bot.id
      });

      logger.info(`Deducted ${cost} points from ${user.email} for bot ${botName}`);
    }

    res.json({
      success: true,
      message: 'Bot deployment started successfully',
      botId: bot.id,
      botName: bot.name,
      nextStep: 'pairing',
      redirectUrl: `/pair.html?botId=${bot.id}`,
      bot: {
        id: bot.id,
        name: bot.name,
        status: bot.status,
        cost: bot.cost
      }
    });

    // Démarrer le processus de pairing automatiquement
    // (le frontend redirige vers /pair)

  } catch (error) {
    logger.error('Deployment error:', error);
    res.status(500).json({ 
      error: 'Failed to start deployment',
      details: error.message 
    });
  }
});

// Obtenir le statut d'un bot
router.get('/status/:botId', async (req, res) => {
  try {
    const { botId } = req.params;
    const user = req.user;

    const bot = await db.getBotById(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    // Vérifier les permissions
    if (bot.owner !== user.email && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Vérifier l'état du processus si le bot est en ligne
    let processInfo = null;
    if (bot.status === 'online' && bot.pid) {
      processInfo = botManager.getProcessInfo(botId);
    }

    // Vérifier les logs récents
    const logs = bot.logs ? bot.logs.slice(-10) : [];

    res.json({
      botId: bot.id,
      name: bot.name,
      status: bot.status,
      phoneNumber: bot.phoneNumber,
      pairingCode: bot.pairingCode,
      deployedAt: bot.deployedAt,
      pid: bot.pid,
      githubRepo: bot.githubRepo,
      cost: bot.cost,
      processInfo: processInfo,
      recentLogs: logs,
      canManage: ['online', 'offline', 'error'].includes(bot.status),
      needsPairing: bot.status === 'pending' || bot.status === 'pairing_failed'
    });

  } catch (error) {
    logger.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to get bot status' });
  }
});

// Redémarrer un bot
router.post('/restart/:botId', async (req, res) => {
  try {
    const { botId } = req.params;
    const user = req.user;

    const bot = await db.getBotById(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.owner !== user.email && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Arrêter le bot s'il est en cours d'exécution
    if (bot.status === 'online' && bot.pid) {
      const stopped = botManager.stopBot(botId);
      if (!stopped) {
        logger.warn(`Failed to stop bot ${botId} before restart`);
      }
    }

    // Mettre à jour le statut
    await db.updateBot(botId, {
      status: 'restarting',
      lastRestart: new Date().toISOString(),
      pid: null
    });

    logger.info(`Restarting bot ${botId} (${bot.name}) by ${user.email}`);

    // Redémarrer le bot (si une session existe)
    const baileysPairing = require('../services/baileysPairing');
    const sessionStatus = await baileysPairing.checkSessionStatus(
      user.email,
      botId
    );

    if (sessionStatus.connected) {
      // Redéployer le bot
      const deployResult = await botManager.deployBot(bot);
      
      if (deployResult.success) {
        await db.updateBot(botId, {
          status: 'online',
          pid: deployResult.pid,
          deployedAt: new Date().toISOString()
        });

        res.json({
          success: true,
          message: 'Bot restarted successfully',
          botId: botId,
          status: 'online',
          pid: deployResult.pid
        });
      } else {
        await db.updateBot(botId, {
          status: 'error',
          error: deployResult.error
        });

        res.status(500).json({
          error: 'Failed to restart bot',
          details: deployResult.error
        });
      }
    } else {
      // Pas de session, mettre en attente de pairing
      await db.updateBot(botId, {
        status: 'pending',
        error: 'No active session found'
      });

      res.json({
        success: false,
        message: 'No active session found',
        botId: botId,
        status: 'pending',
        needsPairing: true
      });
    }

  } catch (error) {
    logger.error('Restart error:', error);
    res.status(500).json({ error: 'Failed to restart bot' });
  }
});

// Arrêter un bot
router.post('/stop/:botId', async (req, res) => {
  try {
    const { botId } = req.params;
    const user = req.user;

    const bot = await db.getBotById(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.owner !== user.email && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Arrêter le processus
    const stopped = botManager.stopBot(botId);
    
    if (stopped || bot.status !== 'online') {
      await db.updateBot(botId, {
        status: 'offline',
        pid: null,
        stoppedAt: new Date().toISOString()
      });

      logger.info(`Bot ${botId} (${bot.name}) stopped by ${user.email}`);

      res.json({
        success: true,
        message: 'Bot stopped successfully',
        botId: botId,
        status: 'offline'
      });
    } else {
      res.status(500).json({
        error: 'Failed to stop bot process',
        botId: botId,
        status: bot.status
      });
    }

  } catch (error) {
    logger.error('Stop error:', error);
    res.status(500).json({ error: 'Failed to stop bot' });
  }
});

// Supprimer un bot
router.delete('/delete/:botId', async (req, res) => {
  try {
    const { botId } = req.params;
    const user = req.user;

    const bot = await db.getBotById(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.owner !== user.email && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Arrêter le bot s'il est en cours d'exécution
    if (bot.status === 'online') {
      botManager.stopBot(botId);
    }

    // Supprimer les fichiers de session et config
    const baileysPairing = require('../services/baileysPairing');
    await baileysPairing.deleteSession(user.email, botId);
    
    const fs = require('fs').promises;
    const configPath = path.join(__dirname, '../configs', user.email, botId);
    try {
      await fs.rm(configPath, { recursive: true, force: true });
    } catch {}

    // Supprimer de la base de données
    await db.deleteBot(botId);

    logger.info(`Bot ${botId} (${bot.name}) deleted by ${user.email}`);

    res.json({
      success: true,
      message: 'Bot deleted successfully',
      botId: botId
    });

  } catch (error) {
    logger.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete bot' });
  }
});

// Obtenir les templates de bots disponibles
router.get('/templates', async (req, res) => {
  try {
    const templates = [
      {
        id: 'whatsapp-basic',
        name: 'WhatsApp Basic Bot',
        description: 'Bot WhatsApp simple avec commandes de base',
        githubRepo: 'https://github.com/hextech-templates/whatsapp-basic-bot',
        cost: 10,
        category: 'whatsapp',
        features: [
          'Réponses automatiques',
          'Message de bienvenue',
          'Commandes !help, !ping',
          'Création de stickers'
        ],
        recommended: true
      },
      {
        id: 'whatsapp-advanced',
        name: 'WhatsApp Advanced Bot',
        description: 'Bot WhatsApp avancé avec IA et plugins',
        githubRepo: 'https://github.com/hextech-templates/whatsapp-advanced-bot',
        cost: 25,
        category: 'whatsapp',
        features: [
          'Chat IA (GPT-3.5)',
          'Téléchargement de médias',
          'Gestion de groupes',
          'Système de modération',
          'Commandes personnalisables'
        ],
        recommended: false
      },
      {
        id: 'business-bot',
        name: 'Business WhatsApp Bot',
        description: 'Bot professionnel pour entreprises',
        githubRepo: 'https://github.com/hextech-templates/business-whatsapp-bot',
        cost: 50,
        category: 'business',
        features: [
          'Système de tickets',
          'Messages de broadcast',
          'Base de données clients',
          'Statistiques avancées',
          'Support multi-langues'
        ],
        recommended: false
      },
      {
        id: 'entertainment-bot',
        name: 'Entertainment Bot',
        description: 'Bot de divertissement avec jeux',
        githubRepo: 'https://github.com/hextech-templates/entertainment-bot',
        cost: 15,
        category: 'entertainment',
        features: [
          'Jeux interactifs',
          'Citations inspirantes',
          'Météo',
          'Actualités',
          'Musique/Radio'
        ],
        recommended: true
      }
    ];

    res.json({
      success: true,
      templates: templates,
      count: templates.length,
      categories: ['whatsapp', 'business', 'entertainment']
    });

  } catch (error) {
    logger.error('Templates error:', error);
    res.status(500).json({ error: 'Failed to get templates' });
  }
});

module.exports = router;
