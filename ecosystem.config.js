const fs = require('fs');
const path = require('path');

// Deteksi otomatis jika virtual environment (venv) tersedia
const venvPython = path.join(__dirname, 'venv', 'bin', 'python');
const pythonInterpreter = fs.existsSync(venvPython) ? venvPython : 'python3';

module.exports = {
  apps: [
    {
      name: "telegram-listener",
      script: "listener.py",
      interpreter: pythonInterpreter,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "dlmm-position-manager",
      script: "server.js",
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
