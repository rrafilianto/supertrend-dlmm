module.exports = {
  apps: [
    {
      name: "telegram-listener",
      script: "listener.py",
      interpreter: "python3",
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
