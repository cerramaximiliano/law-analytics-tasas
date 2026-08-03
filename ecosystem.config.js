module.exports = {
  apps: [
    {
      name: 'law-analytics-tasas',
      script: './app.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        CHROMIUM_PATH: '/usr/local/bin/chromium'
      },
      env_development: {  // Nuevo: configuración específica para desarrollo
        NODE_ENV: 'development',
        PORT: 3000,
        CHROMIUM_PATH: '/usr/local/bin/chromium'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        CHROMIUM_PATH: '/usr/local/bin/chromium'
      },
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true
    },
  ],
};