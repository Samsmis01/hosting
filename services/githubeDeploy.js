const { exec } = require("child_process");

function cloneBot(repoUrl, targetDir) {
  return new Promise((resolve, reject) => {
    exec(`git clone ${repoUrl} ${targetDir}`, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

module.exports = { cloneBot };
