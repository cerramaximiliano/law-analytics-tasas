const mongoose = require('mongoose');
const config = require('../config');
const logger = require('./logger');

// Referencia para reiniciar tareas tras reconexión
let taskService = null;

/**
 * Inicializa la conexión a MongoDB
 * 
 * @returns {Promise} - Promesa que se resuelve cuando la conexión se establece
 */
exports.connect = async () => {
  try {
    // Configurar Mongoose
    // La opción strictQuery debe configurarse antes de la conexión y no como parte de las opciones
    mongoose.set('strictQuery', false);
    
    // Agregar monitoreo de eventos
    mongoose.connection.on('connected', () => {
      logger.info('MongoDB: Conexión establecida');
    });
    
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB: Conexión cerrada');
    });
    
    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB: Error en conexión: ${err.message}`);
    });
    
    // Añadir evento de reconexión para reiniciar tareas
    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB: Reconexión establecida');
      
      // Reiniciar tareas si el servicio está disponible
      if (taskService) {
        logger.info('Reinicializando tareas programadas tras reconexión...');
        taskService.initializeTasks();
      }
    });
    
    // Manejar eventos de proceso para cerrar conexión ordenadamente
    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      logger.info('MongoDB: Conexión cerrada por terminación de aplicación');
      process.exit(0);
    });
    
    // Conectar a la base de datos
    // Sin credenciales en el log: la URI de Atlas lleva user:password.
    logger.info(`MongoDB: Conectando a ${String(config.mongodb.url).replace(/\/\/[^@/]+@/, '//***@')}`);
    // Pasar las opciones: sin ellas el driver usa maxPoolSize=100 y este
    // proceso llegó a sostener ~95 conexiones contra Atlas (ver config/index.js).
    await mongoose.connect(config.mongodb.url, config.mongodb.options);
    
    return mongoose.connection;
  } catch (error) {
    logger.error(`MongoDB: Error al conectar: ${error.message}`);
    throw error;
  }
};

/**
 * Cierra la conexión a MongoDB
 * 
 * @returns {Promise} - Promesa que se resuelve cuando la conexión se cierra
 */
exports.disconnect = async () => {
  if (mongoose.connection.readyState === 0) {
    logger.info('MongoDB: La conexión ya está cerrada');
    return;
  }
  
  try {
    await mongoose.connection.close();
    logger.info('MongoDB: Conexión cerrada correctamente');
  } catch (error) {
    logger.error(`MongoDB: Error al cerrar conexión: ${error.message}`);
    throw error;
  }
};

/**
 * Obtiene el estado actual de la conexión
 * 
 * @returns {Object} - Estado de la conexión
 */
exports.getStatus = () => {
  const states = {
    0: 'Desconectado',
    1: 'Conectado',
    2: 'Conectando',
    3: 'Desconectando'
  };
  
  return {
    state: mongoose.connection.readyState,
    stateDescription: states[mongoose.connection.readyState],
    host: mongoose.connection.host || 'Ninguno',
    name: mongoose.connection.name || 'Ninguno'
  };
};

/**
 * Registra el servicio de tareas para poder reiniciarlo en caso de reconexión
 * 
 * @param {Object} service - Servicio de tareas
 */
exports.registerTaskService = (service) => {
  taskService = service;
  logger.info('Servicio de tareas registrado para reinicialización automática');
};

/**
 * Verifica si la conexión a MongoDB está activa
 * 
 * @returns {Boolean} - true si está conectado
 */
exports.isConnected = () => {
  return mongoose.connection.readyState === 1;
};