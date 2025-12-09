const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const moment = require('moment');

// Cargar configuración
const config = require('./server/config');
const logger = require('./server/utils/logger');
const database = require("./server/utils/database")

// Obtener secretos de AWS
const retrieveSecrets = require('./server/config/env');
dotenv.config()

// Servicios
const taskService = require('./server/services/tasks/taskService');

// Configurar Express
const app = express();

// MIDDLEWARE DE DEPURACIÓN - DEBE ESTAR PRIMERO
app.use((req, res, next) => {
    console.log('\n----- NUEVA SOLICITUD -----');
    console.log('Origen:', req.headers.origin);
    console.log('Método:', req.method);
    console.log('Ruta:', req.url);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    next();
});

// Middleware básicos
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// CONFIGURACIÓN CORS MEJORADA
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://lawanalytics.app',
    'https://dashboard.lawanalytics.app'
];

// Manejo de preflight OPTIONS explícito
app.options('*', (req, res) => {
    const origin = req.headers.origin;

    if (!origin || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        res.status(204).end();
    } else {
        console.log(`CORS Preflight bloqueado para origen: ${origin}`);
        res.status(403).end();
    }
});

// Configuración CORS para solicitudes regulares
app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (!origin || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        next();
    } else {
        console.log(`CORS bloqueado para origen: ${origin}`);
        res.status(403).json({ error: 'Origen no permitido por CORS' });
    }
});

// Middleware para archivos estáticos
app.use(express.static(path.join(__dirname, '../public')));

// ENDPOINT DE PRUEBA CORS
app.get('/api/cors-test', (req, res) => {
    console.log('Prueba CORS exitosa');
    console.log('Cookies recibidas:', req.cookies);
    res.json({
        success: true,
        message: 'CORS configurado correctamente',
        cookies: req.cookies
    });
});

// Registrar rutas
const routes = require('./server/routes/index');
app.use('/api', routes);

// Manejador de errores - DEBE ESTAR AL FINAL
app.use((err, req, res, next) => {
    console.error(`Error no controlado: ${err.message}`);
    console.error(err.stack);

    if (err.message.includes('CORS')) {
        return res.status(403).json({
            ok: false,
            status: 403,
            error: 'Error de CORS: Origen no permitido'
        });
    }

    res.status(500).json({
        ok: false,
        status: 500,
        error: 'Error interno del servidor'
    });
});

// Ruta para errores 404
app.use((req, res) => {
    res.status(404).json({
        ok: false,
        status: 404,
        error: 'Recurso no encontrado'
    });
});

// Resto del código igual...
/**
 * Inicialización de la aplicación
 */
async function inicializarApp() {
    try {
        logger.info('Iniciando aplicación...');

        // Recuperar secretos de AWS
        logger.info('Recuperando secretos...');
        const secretsString = await retrieveSecrets();
        await fs.writeFile(".env", secretsString);
        dotenv.config();

        // Configurar zona horaria
        moment.tz.setDefault(config.server.timezone);

        // Conectar a la base de datos usando el utilitario
        await database.connect();

        // Inicializar tareas programadas
        logger.info('Inicializando tareas programadas...');
        taskService.initializeTasks();

        // Iniciar servidor
        const server = app.listen(config.server.port, async () => {
            logger.info(`Servidor escuchando en el puerto ${config.server.port}`);

        });


        // Manejar cierre ordenado
        process.on('SIGTERM', () => {
            logger.info('Señal SIGTERM recibida. Cerrando servidor...');
            server.close(async () => {
                logger.info('Servidor HTTP cerrado');
                await database.disconnect();
                process.exit(0);
            });
        });

        return server;
    } catch (error) {
        logger.error(`Error al inicializar la aplicación: ${error.message}`);
        logger.error(error.stack);
        process.exit(1);
    }
}

// Si este archivo es ejecutado directamente (no importado)
if (require.main === module) {
    inicializarApp();
}

module.exports = { app, inicializarApp };