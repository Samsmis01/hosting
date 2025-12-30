const bcrypt = require('bcrypt');
module.exports = [
  {
    email: "lolalor20@gmail.com",
    passwordHash: bcrypt.hashSync("armandfavnel", 10),
    role: "admin",
    points: Infinity,
    createdAt: new Date()
  }
];
