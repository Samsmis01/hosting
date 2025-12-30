const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');

class JSONDatabase {
  constructor() {
    this.dataPath = path.join(__dirname, 'data');
    this.usersFile = path.join(this.dataPath, 'users.json');
    this.botsFile = path.join(this.dataPath, 'bots.json');
    this.pointsFile = path.join(this.dataPath, 'points.json');
  }

  async initialize() {
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      
      // Initialiser les fichiers s'ils n'existent pas
      await this.initializeFile(this.usersFile, async () => {
        const adminHash = await bcrypt.hash(
          process.env.ADMIN_PASSWORD || 'armandfavnel',
          10
        );
        
        return [{
          email: process.env.ADMIN_EMAIL || 'lolalor20@gmail.com',
          passwordHash: adminHash,
          points: 999999,
          role: 'admin',
          createdAt: new Date().toISOString(),
          lastPointClaim: null,
          pointCooldown: null,
          bots: []
        }];
      });

      await this.initializeFile(this.botsFile, () => []);
      await this.initializeFile(this.pointsFile, () => []);

      console.log('✅ Database initialized successfully');
    } catch (error) {
      console.error('❌ Database initialization failed:', error);
      throw error;
    }
  }

  async initializeFile(filePath, initialDataFn) {
    try {
      await fs.access(filePath);
    } catch {
      const initialData = await initialDataFn();
      await fs.writeFile(filePath, JSON.stringify(initialData, null, 2));
    }
  }

  async readFile(filePath) {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  }

  // User operations
  async findUser(email) {
    const users = await this.readFile(this.usersFile);
    return users.find(user => user.email === email);
  }

  async createUser(userData) {
    const users = await this.readFile(this.usersFile);
    
    if (users.find(user => user.email === userData.email)) {
      throw new Error('Email already registered');
    }
    
    const newUser = {
      ...userData,
      points: 10,
      role: 'user',
      createdAt: new Date().toISOString(),
      lastPointClaim: null,
      pointCooldown: null,
      bots: []
    };
    
    users.push(newUser);
    await this.writeFile(this.usersFile, users);
    return newUser;
  }

  async updateUser(email, updates) {
    const users = await this.readFile(this.usersFile);
    const index = users.findIndex(user => user.email === email);
    
    if (index === -1) throw new Error('User not found');
    
    users[index] = { ...users[index], ...updates };
    await this.writeFile(this.usersFile, users);
    return users[index];
  }

  async getAllUsers() {
    return await this.readFile(this.usersFile);
  }

  // Bot operations
  async createBot(botData) {
    const bots = await this.readFile(this.botsFile);
    
    const newBot = {
      id: this.generateId(),
      ...botData,
      status: 'pending',
      deployedAt: new Date().toISOString(),
      pid: null,
      sessionPath: null,
      phoneNumber: null,
      pairingCode: null,
      config: {},
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    bots.push(newBot);
    await this.writeFile(this.botsFile, bots);
    
    // Ajouter le bot à l'utilisateur
    const users = await this.readFile(this.usersFile);
    const userIndex = users.findIndex(u => u.email === botData.owner);
    if (userIndex !== -1) {
      users[userIndex].bots = users[userIndex].bots || [];
      users[userIndex].bots.push(newBot.id);
      await this.writeFile(this.usersFile, users);
    }
    
    return newBot;
  }

  async getBotById(botId) {
    const bots = await this.readFile(this.botsFile);
    return bots.find(bot => bot.id === botId);
  }

  async getBotsByOwner(ownerEmail) {
    const bots = await this.readFile(this.botsFile);
    return bots.filter(bot => bot.owner === ownerEmail);
  }

  async getAllBots() {
    return await this.readFile(this.botsFile);
  }

  async updateBot(botId, updates) {
    const bots = await this.readFile(this.botsFile);
    const index = bots.findIndex(bot => bot.id === botId);
    
    if (index === -1) throw new Error('Bot not found');
    
    bots[index] = { 
      ...bots[index], 
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    await this.writeFile(this.botsFile, bots);
    return bots[index];
  }

  async deleteBot(botId) {
    const bots = await this.readFile(this.botsFile);
    const bot = bots.find(b => b.id === botId);
    
    if (!bot) throw new Error('Bot not found');
    
    // Retirer le bot de l'utilisateur
    const users = await this.readFile(this.usersFile);
    const userIndex = users.findIndex(u => u.email === bot.owner);
    if (userIndex !== -1) {
      users[userIndex].bots = (users[userIndex].bots || []).filter(id => id !== botId);
      await this.writeFile(this.usersFile, users);
    }
    
    // Supprimer le bot
    const filteredBots = bots.filter(bot => bot.id !== botId);
    await this.writeFile(this.botsFile, filteredBots);
    
    return true;
  }

  // Points operations
  async addPointsLog(logData) {
    const logs = await this.readFile(this.pointsFile);
    
    const newLog = {
      id: this.generateId(),
      ...logData,
      timestamp: new Date().toISOString()
    };
    
    logs.push(newLog);
    await this.writeFile(this.pointsFile, logs);
    return newLog;
  }

  async getUserPointsLogs(email, limit = 50) {
    const logs = await this.readFile(this.pointsFile);
    const userLogs = logs.filter(log => log.user === email);
    return userLogs.slice(-limit).reverse();
  }

  async getAllPointsLogs(limit = 100) {
    const logs = await this.readFile(this.pointsFile);
    return logs.slice(-limit).reverse();
  }

  // Helper methods
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

const db = new JSONDatabase();

module.exports = {
  db,
  initializeDatabase: () => db.initialize()
};
