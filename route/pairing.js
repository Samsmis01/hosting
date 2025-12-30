const express = require('express');
const router = express.Router();
const { db } = require('../database');
const BaileysPairing = require('../services/baileysPairing');
const logger = require('../utils/logger');

// Générer un code de pairing
router.post('/generate', async (req, res) => {
  try {
    const { phoneNumber, botId } = req.body;
    const user = req.user;

    // Validation
    if (!phoneNumber || !botId) {
      return res.status(400).json({ error: 'Phone number and bot ID are required' });
    }

    // Nettoyer le numéro
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (cleanPhone.length < 9) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // Vérifier le bot
    const bot = await db.getBotById(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.owner !== user.email && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    logger.info(`Generating pairing code for ${cleanPhone}, bot: ${botId}`);

    try {
      // Générer le code de pairing
      const pairingCode = await BaileysPairing.generatePairingCode(
        cleanPhone,
        user.email,
        botId
      );

      // Mettre à jour le bot
      await db.updateBot(botId, {
        phoneNumber: cleanPhone,
        pairingCode: pairingCode,
        pairingStatus: 'pending',
        status: 'pairing',
        sessionPath: BaileysPairing.getSessionPath(user.email, botId)
      });

      logger.info(`Pairing code generated for ${cleanPhone}: ${pairingCode}`);

      res.json({
        success: true,
        message: 'Pairing code generated successfully',
        pairingCode: pairingCode,
        phoneNumber: cleanPhone,
        botId: botId,
        instructions: [
          '1. Ouvrez WhatsApp sur votre téléphone',
          '2. Allez dans Paramètres > Périphériques liés',
          '3. Cliquez sur "Ajouter un périphérique"',
          '4. Entrez le code ci-dessus',
          '5. Patientez jusqu\'à ce que la connexion soit établie'
        ]
      });

    } catch (pairError) {
      logger.error('Pairing failed:', pairError);
      
      await db.updateBot(botId, {
        status: 'pairing_failed',
        error: pairError.message
      });

      res.status(500).json({
        error: 'Failed to generate pairing code',
        details: pairError.message
      });
    }

  } catch (error) {
    logger.error('Pairing route error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vérifier le statut du pairing
router.get('/status/:botId', async (req, res) => {
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

    // Vérifier l'état de la session
    const sessionStatus = await BaileysPairing.checkSessionStatus(
      user.email,
      botId
    );

    let shouldDeploy = false;
    
    // Si la session est connectée mais le bot n'est pas online
    if (sessionStatus.connected && bot.status !== 'online') {
      shouldDeploy = true;
      
      // Mettre à jour le statut du bot
      await db.updateBot(botId, {
        status: 'online',
        pairingStatus: 'connected',
        connectedAt: new Date().toISOString()
      });

      logger.info(`Bot ${botId} session connected, triggering deployment`);
    }

    // Récupérer les informations de session
    const sessionInfo = await BaileysPairing.getSessionInfo(
      user.email,
      botId
    );

    res.json({
      botId: botId,
      paired: sessionStatus.exists,
      connected: sessionStatus.connected,
      phoneNumber: bot.phoneNumber,
      pairingCode: bot.pairingCode,
      status: sessionStatus.connected ? 'online' : bot.status,
      sessionExists: sessionStatus.exists,
      sessionInfo: sessionInfo,
      shouldDeploy: shouldDeploy,
      lastChecked: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to check pairing status' });
  }
});

// Vérifier la connexion manuellement
router.post('/verify/:botId', async (req, res) => {
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

    const sessionStatus = await BaileysPairing.checkSessionStatus(
      user.email,
      botId
    );

    if (sessionStatus.connected) {
      // La session est connectée, lancer le déploiement
      const botManager = require('../services/botManager');
      const deployResult = await botManager.deployBot(bot);
      
      if (deployResult.success) {
        await db.updateBot(botId, {
          status: 'online',
          pid: deployResult.pid,
          deployedAt: new Date().toISOString()
        });

        res.json({
          success: true,
          message: 'Bot connected and deployed successfully',
          botId: botId,
          status: 'online',
          pid: deployResult.pid
        });
      } else {
        res.status(500).json({
          error: 'Bot connected but deployment failed',
          details: deployResult.error
        });
      }
    } else {
      res.status(400).json({
        error: 'Bot not connected',
        paired: false,
        sessionExists: sessionStatus.exists
      });
    }

  } catch (error) {
    logger.error('Verify error:', error);
    res.status(500).json({ error: 'Failed to verify connection' });
  }
});

// Re-générer un code de pairing
router.post('/regenerate/:botId', async (req, res) => {
  try {
    const { botId } = req.params;
    const { phoneNumber } = req.body;
    const user = req.user;

    const bot = await db.getBotById(botId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    if (bot.owner !== user.email && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Supprimer l'ancienne session
    await BaileysPairing.deleteSession(user.email, botId);

    // Générer un nouveau code
    const cleanPhone = phoneNumber || bot.phoneNumber;
    if (!cleanPhone) {
      return res.status(400).json({ error: 'Phone number required' });
    }

    const pairingCode = await BaileysPairing.generatePairingCode(
      cleanPhone,
      user.email,
      botId
    );

    await db.updateBot(botId, {
      phoneNumber: cleanPhone,
      pairingCode: pairingCode,
      pairingStatus: 'pending',
      status: 'pairing'
    });

    res.json({
      success: true,
      message: 'New pairing code generated',
      pairingCode: pairingCode,
      phoneNumber: cleanPhone
    });

  } catch (error) {
    logger.error('Regenerate error:', error);
    res.status(500).json({ error: 'Failed to regenerate pairing code' });
  }
});

module.exports = router;
