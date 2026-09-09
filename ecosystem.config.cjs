/**
 * pm2 ecosystem config for claude-mail-mcp — local development only.
 *
 * pm2 runs as the invoking user and provides no isolation of any kind. The
 * deployment is docker compose; docs/DEPLOYMENT.md, "Running from source", says
 * why there is no supported from-source production path.
 *
 * Start: pm2 start ecosystem.config.cjs && pm2 save
 */
module.exports = {
  apps: [
    {
      name: "claude-mail-mcp",
      // Absolute path to your checkout — pm2 does not derive one from this
      // file's own location. Replace it with yours.
      cwd: "/home/you/claude-mail-mcp",
      script: "dist/index.js",
      // Node 20+ loads .env from --env-file natively, no dotenv dep needed.
      node_args: "--env-file=.env --enable-source-maps",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "256M",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
