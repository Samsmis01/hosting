// database/bots.js
module.exports = [
  {
    id: "hexgate-v1",
    name: "HexGate V1",
    description: "Bot WhatsApp avancé basé sur Baileys (HEXGATE)",
    
    // Dépôt GitHub réel du bot
    githubRepo: "https://github.com/Samsmis01/hexgatev1.git",
    
    // Branche à utiliser
    branch: "main",
    
    // Fichier d’entrée du bot
    entry: "index.js",
    
    // Coût en points pour déployer
    cost: 5,
    
    // Type de bot
    type: "whatsapp",
    
    // Statut global (sera remplacé par un statut par utilisateur)
    status: "offline",
    
    // Options de déploiement
    deploy: {
      installCmd: "npm install",
      startCmd: "node index.js",
      nodeVersion: "18"
    },
    
    // Sécurité / règles
    limits: {
      maxInstancesPerUser: 1,
      requirePairing: true
    },
    
    createdAt: new Date()
  }
];
