const cron = require('node-cron');
const moment = require('moment');
const config = require('../../config');
const logger = require('../../utils/logger');
const database = require('../../utils/database');
const cronConfig = require('../../config/cronConfig');

// Importar servicios
const { mainConsejoService, findMissingDataService } = require('../scrapers/tasas/consejoService');
const { actualizarTasaActivaBNAConReintentos } = require('../scrapers/tasas/bnaService');
const { mainBnaPasivaService } = require("../scrapers/tasas/bnaProcesadorPDF");
const { getCurrentRateAndSave, findMissingDataServiceBcra } = require("../scrapers/tasas/bcraService");
const { findMissingDataColegio, rectificarUltimasFechas } = require('../scrapers/tasas/colegioService');
const { fillAllGaps } = require('../scrapers/tasas/cpacfGapFillerService');
const { programarVerificacionTasas } = require('../../utils/verificadorTasas');
const { cleanServerFiles } = require('../file_manager/file_manager');
const { updateAllUserStats } = require('../stats/statsSyncService');
const { generateAllUsersAnalytics } = require('../stats/statsAnalysisService');

// Colección de tareas programadas
const tasks = new Map();

// Mapa para asignar números a los IDs de las tareas
const taskNumbers = {};

/**
 * Programa una tarea para ejecutarse periódicamente
 * 
 * @param {String} taskId - Identificador único de la tarea
 * @param {String} cronExpression - Expresión cron para la programación
 * @param {Function} taskFunction - Función a ejecutar
 * @param {String} description - Descripción de la tarea
 * @returns {Boolean} - true si la tarea se programó correctamente
 */
function scheduleTask(taskId, cronExpression, taskFunction, description) {
  try {
    // Verificar si la tarea ya existe y detenerla si es así
    if (tasks.has(taskId)) {
      stopTask(taskId);
      logger.info(`Deteniendo tarea existente ${taskId} para reprogramarla`);
    }

    // Verificar expresión cron
    if (!cron.validate(cronExpression)) {
      logger.error(`Expresión cron inválida para la tarea ${taskId}: ${cronExpression}`);
      return false;
    }

    // Crear una función envoltorio que verifique la conexión a MongoDB
    const wrappedTaskFunction = async () => {
      // Verificar la conexión a MongoDB antes de ejecutar la tarea
      if (!database.isConnected()) {
        logger.warn(`La tarea ${taskId} no se ejecutará porque MongoDB no está conectado`);
        return { success: false, skipped: true, reason: 'MongoDB desconectado' };
      }

      logger.info(`Ejecutando tarea: ${taskId} - ${description}`);

      try {
        const startTime = process.hrtime();
        const result = await taskFunction();
        const elapsedTime = process.hrtime(startTime);
        const elapsedTimeMs = (elapsedTime[0] * 1000 + elapsedTime[1] / 1000000).toFixed(2);

        // Actualizar información de última ejecución
        const taskInfo = tasks.get(taskId);
        if (taskInfo) {
          taskInfo.lastRun = new Date();
          tasks.set(taskId, taskInfo);
        }

        logger.info(`Tarea ${taskId} completada en ${elapsedTimeMs}ms con resultado: ${JSON.stringify(result)}`);
        return { success: true, result, elapsedTimeMs };
      } catch (error) {
        logger.error(`Error al ejecutar tarea ${taskId}: ${error.message}`);
        return { success: false, error: error.message };
      }
    };

    // Programar tarea
    const task = cron.schedule(cronExpression, wrappedTaskFunction, {
      scheduled: true,
      timezone: config.server.timezone
    });

    // Guardar referencia a la función original para ejecuciones manuales
    task.job = wrappedTaskFunction;

    // Guardar tarea
    tasks.set(taskId, {
      id: taskId,
      description,
      expression: cronExpression,
      task,
      lastRun: null,
      status: 'scheduled'
    });

    logger.info(`Tarea programada: ${taskId} - ${description} con expresión cron: ${cronExpression}`);
    return true;
  } catch (error) {
    logger.error(`Error al programar tarea ${taskId}: ${error.message}`);
    return false;
  }
}

/**
 * Detiene una tarea programada
 * 
 * @param {String|Number} taskIdentifier - Número o ID de la tarea
 * @returns {Boolean} - true si la tarea se detuvo correctamente
 */
function stopTask(taskIdentifier) {
  const taskId = getTaskIdByIdentifier(taskIdentifier);
  
  if (!taskId) {
    logger.warn(`La tarea con identificador ${taskIdentifier} no existe`);
    return false;
  }

  try {
    const taskInfo = tasks.get(taskId);
    taskInfo.task.stop();
    taskInfo.status = 'stopped';
    tasks.set(taskId, taskInfo);

    logger.info(`Tarea detenida: ${taskId}`);
    return true;
  } catch (error) {
    logger.error(`Error al detener tarea ${taskId}: ${error.message}`);
    return false;
  }
}

/**
 * Inicia una tarea que estaba detenida
 * 
 * @param {String|Number} taskIdentifier - Número o ID de la tarea
 * @returns {Boolean} - true si la tarea se inició correctamente
 */
function startTask(taskIdentifier) {
  const taskId = getTaskIdByIdentifier(taskIdentifier);
  
  if (!taskId) {
    logger.warn(`La tarea con identificador ${taskIdentifier} no existe`);
    return false;
  }

  try {
    const taskInfo = tasks.get(taskId);

    if (taskInfo.status !== 'stopped') {
      logger.warn(`La tarea ${taskId} no está detenida`);
      return false;
    }

    taskInfo.task.start();
    taskInfo.status = 'scheduled';
    tasks.set(taskId, taskInfo);

    logger.info(`Tarea iniciada: ${taskId}`);
    return true;
  } catch (error) {
    logger.error(`Error al iniciar tarea ${taskId}: ${error.message}`);
    return false;
  }
}

/**
 * Obtiene el ID de una tarea a partir de su número o ID
 * 
 * @param {String|Number} taskIdentifier - Número o ID de la tarea
 * @returns {String|null} - ID de la tarea o null si no se encuentra
 */
function getTaskIdByIdentifier(taskIdentifier) {
  // Si es un número, buscar por número de tarea
  if (!isNaN(taskIdentifier) && parseInt(taskIdentifier) > 0) {
    const taskNumber = parseInt(taskIdentifier);
    // Buscar el ID de la tarea con ese número
    for (const [taskId, number] of Object.entries(taskNumbers)) {
      if (number === taskNumber) {
        return taskId;
      }
    }
    return null;
  }
  
  // Si no es un número o no se encontró, verificar si existe directamente como ID
  return tasks.has(taskIdentifier) ? taskIdentifier : null;
}

/**
 * Ejecuta una tarea inmediatamente
 * 
 * @param {String|Number} taskIdentifier - Número o ID de la tarea
 * @returns {Promise} - Resultado de la ejecución
 */
async function executeTaskNow(taskIdentifier) {
  const taskId = getTaskIdByIdentifier(taskIdentifier);
  
  if (!taskId) {
    logger.warn(`La tarea con identificador ${taskIdentifier} no existe`);
    return { success: false, error: 'Tarea no encontrada' };
  }

  try {
    const taskInfo = tasks.get(taskId);
    logger.info(`Ejecutando tarea inmediatamente: ${taskId} - ${taskInfo.description}`);

    // Verificar la conexión a MongoDB antes de ejecutar la tarea
    if (!database.isConnected()) {
      logger.warn(`La ejecución manual de la tarea ${taskId} no se realizará porque MongoDB no está conectado`);
      return { success: false, skipped: true, reason: 'MongoDB desconectado' };
    }

    const result = await taskInfo.task.job();

    // La información de última ejecución ya se actualiza en el job

    return result;
  } catch (error) {
    logger.error(`Error al ejecutar tarea ${taskId} inmediatamente: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Obtiene la lista de todas las tareas programadas
 * 
 * @returns {Array} - Lista de tareas
 */
function getTasksList() {
  const tasksList = [];

  tasks.forEach((taskInfo, taskId) => {
    // Asignar un número si no lo tiene
    if (!taskNumbers[taskId]) {
      // Obtener el siguiente número disponible
      const nextNumber = Object.keys(taskNumbers).length + 1;
      taskNumbers[taskId] = nextNumber;
    }

    tasksList.push({
      id: taskId,
      taskNumber: taskNumbers[taskId],
      description: taskInfo.description,
      status: taskInfo.status,
      expression: taskInfo.expression,
      lastRun: taskInfo.lastRun ? moment(taskInfo.lastRun).format('YYYY-MM-DD HH:mm:ss') : null
    });
  });

  // Ordenar por número de tarea
  tasksList.sort((a, b) => a.taskNumber - b.taskNumber);

  return tasksList;
}

/**
 * Detiene todas las tareas programadas
 */
function stopAllTasks() {
  logger.info('Deteniendo todas las tareas programadas');

  tasks.forEach((taskInfo, taskId) => {
    try {
      taskInfo.task.stop();
      taskInfo.status = 'stopped';
      tasks.set(taskId, taskInfo);
    } catch (error) {
      logger.error(`Error al detener tarea ${taskId}: ${error.message}`);
    }
  });

  logger.info(`Se detuvieron ${tasks.size} tareas programadas`);
}

/**
 * Inicializa las tareas del sistema
 */
function initializeTasks() {
  logger.info('Inicializando tareas programadas');

  // Detener todas las tareas existentes
  stopAllTasks();
  
  // Reiniciar la numeración de tareas
  Object.keys(taskNumbers).forEach(key => {
    delete taskNumbers[key];
  });

  // Tareas de BNA - Tasa Activa
  scheduleTask(
    'bna-tasa-activa-bna',
    cronConfig.bna.tasaActiva.scraping,
    actualizarTasaActivaBNAConReintentos,
    'Scraping de tasa activa BNA desde BNA'
  );

  scheduleTask(
    'búsqueda-fechas-activa-bna',
    cronConfig.bna.tasaActiva.busquedaFechas,
    () => findMissingDataService("tasa_activa_BN", "tasaActivaBNA"),
    'Búsqueda de fechas sin datos y scraping de tasa activa BNA desde Consejo'
  );

  scheduleTask(
    'consejo-tasa-activa-bna',
    cronConfig.bna.tasaActiva.consejo,
    () => mainConsejoService({ tasa: "tasa_activa_BN", database: "tasaActivaBNA" }),
    'Scraping de tasa activa BNA desde Consejo'
  );

  // Tareas Tasa Pasiva BNA
  scheduleTask(
    'bna-tasa-pasiva-bna',
    cronConfig.bna.tasaPasiva.scraping,
    mainBnaPasivaService,
    'Scraping de tasa pasiva BNA desde BNA'
  );

  scheduleTask(
    'consejo-tasa-pasiva-bna',
    cronConfig.bna.tasaPasiva.consejo,
    () => mainConsejoService({ tasa: "tasa_pasiva_BN", database: "tasaPasivaBNA" }),
    'Scraping de tasa pasiva BNA desde Consejo'
  );

  scheduleTask(
    'búsqueda-fechas-pasiva-bna',
    cronConfig.bna.tasaPasiva.busquedaFechas,
    () => findMissingDataService("tasa_pasiva_BN", "tasaPasivaBNA"),
    'Búsqueda de fechas sin datos y scraping de tasa pasiva BNA desde Consejo'
  );

  // Tareas de BCRA
  scheduleTask(
    'bcra-pasiva-bcra',
    cronConfig.bcra.tasaPasiva.scraping,
    () => getCurrentRateAndSave("tasaPasivaBCRA", "43"),
    'Búsqueda de último dato de API BCRA'
  );

  scheduleTask(
    'búsqueda-fechas-pasiva-bcra',
    cronConfig.bcra.tasaPasiva.busquedaFechas,
    () => findMissingDataServiceBcra("tasaPasivaBCRA", "43"),
    'Búsqueda de fechas sin datos y scraping de tasa pasiva BCRA desde API BCRA'
  );

  scheduleTask(
    'bcra-cer-bcra',
    cronConfig.bcra.cer.scraping,
    () => getCurrentRateAndSave("cer", "30"),
    'Búsqueda de último dato de API BCRA - Tasa CER'
  );

  scheduleTask(
    'búsqueda-fechas-cer-bcra',
    cronConfig.bcra.cer.busquedaFechas,
    () => findMissingDataServiceBcra("cer", "30"),
    'Búsqueda de fechas sin datos y scraping de tasa cer BCRA desde API BCRA'
  );

  scheduleTask(
    'bcra-icl-bcra',
    cronConfig.bcra.icl.scraping,
    () => getCurrentRateAndSave("icl", "40"),
    'Búsqueda de último dato de API BCRA - Tasa ICL'
  );

  scheduleTask(
    'búsqueda-fechas-icl-bcra',
    cronConfig.bcra.icl.busquedaFechas,
    () => findMissingDataServiceBcra("icl", "40"),
    'Búsqueda de fechas sin datos y scraping de tasa icl BCRA desde API BCRA'
  );

  // Tareas Colegio
  scheduleTask(
    'busqueda-fechas-tasaActivaCNAT2658',
    cronConfig.colegio.tasaActivaCNAT2658.busquedaFechas,
    () => findMissingDataColegio("tasaActivaCNAT2658", "22"),
    'Búsqueda de fechas sin datos y scraping de tasa CNAT 2658'
  );

  scheduleTask(
    'busqueda-fechas-tasaActivaCNAT2764',
    cronConfig.colegio.tasaActivaCNAT2764.busquedaFechas,
    () => findMissingDataColegio("tasaActivaCNAT2764", "23"),
    'Búsqueda de fechas sin datos y scraping de tasa CNAT 2764'
  );

  scheduleTask(
    'busqueda-fechas-tasaActivaBNA',
    cronConfig.colegio.tasaActivaBNA.busquedaFechas,
    () => findMissingDataColegio("tasaActivaBNA", "1"),
    'Búsqueda de fechas sin datos y scraping de tasa Activa Banco Nación. Efectiva mensual vencida.'
  );

  scheduleTask(
    'busqueda-fechas-tasaActivaTnaBNA',
    cronConfig.colegio.tasaActivaTnaBNA.busquedaFechas,
    () => findMissingDataColegio("tasaActivaTnaBNA", "25"),
    'Búsqueda de fechas sin datos y scraping de tasa Activa Cartera general (préstamos) nominal anual vencida a 30 días del Banco Nacion.'
  );

  scheduleTask(
    'busqueda-fechas-tasaPasivaBNA',
    cronConfig.colegio.tasaPasivaBNA.busquedaFechas,
    () => findMissingDataColegio("tasaPasivaBNA", "2"),
    'Búsqueda de fechas sin datos y scraping de tasa pasiva BNA'
  );

  // ── Banco Provincia ──────────────────────────────────────────────────────────
  scheduleTask(
    'busqueda-fechas-tasaPasivaBP',
    cronConfig.colegio.tasaPasivaBP.busquedaFechas,
    () => findMissingDataColegio("tasaPasivaBP", "4"),
    'Búsqueda de fechas faltantes — Tasa Pasiva Banco Provincia'
  );
  scheduleTask(
    'rectificacion-tasaPasivaBP',
    cronConfig.colegio.tasaPasivaBP.rectificacion,
    () => rectificarUltimasFechas("tasaPasivaBP", "4"),
    'Rectificación de últimos días — Tasa Pasiva Banco Provincia'
  );

  scheduleTask(
    'busqueda-fechas-tasaActivaBPDolares',
    cronConfig.colegio.tasaActivaBPDolares.busquedaFechas,
    () => findMissingDataColegio("tasaActivaBPDolares", "14"),
    'Búsqueda de fechas faltantes — Tasa Activa Banco Provincia en Dólares'
  );
  scheduleTask(
    'rectificacion-tasaActivaBPDolares',
    cronConfig.colegio.tasaActivaBPDolares.rectificacion,
    () => rectificarUltimasFechas("tasaActivaBPDolares", "14"),
    'Rectificación de últimos días — Tasa Activa Banco Provincia en Dólares'
  );

  scheduleTask(
    'busqueda-fechas-tasaPasivaBPDolares',
    cronConfig.colegio.tasaPasivaBPDolares.busquedaFechas,
    () => findMissingDataColegio("tasaPasivaBPDolares", "15"),
    'Búsqueda de fechas faltantes — Tasa Pasiva Banco Provincia en Dólares'
  );
  scheduleTask(
    'rectificacion-tasaPasivaBPDolares',
    cronConfig.colegio.tasaPasivaBPDolares.rectificacion,
    () => rectificarUltimasFechas("tasaPasivaBPDolares", "15"),
    'Rectificación de últimos días — Tasa Pasiva Banco Provincia en Dólares'
  );

  scheduleTask(
    'cpacf-gap-filler',
    cronConfig.cpacfGapFiller.diario,
    fillAllGaps,
    'Rellena fechas faltantes de todas las tasas soportadas por CPACF'
  );

  scheduleTask(
    'eliminar-files',
    cronConfig.manager_files.cleanup,
    cleanServerFiles,
    'Elimina todos los archivos de la carpeta files',
  )


  scheduleTask(
    'sync-stats',
    cronConfig.syncStats.diaria,
    updateAllUserStats,
    'Sincroniza estadísticas de usuarios'
  )

  scheduleTask(
    'analysis-stats',
    cronConfig.generateAnalysis.generateAllUsersAnalysis.diaria,
    generateAllUsersAnalytics,
    'Genera analisis de todos los usuarios'
  )


  programarVerificacionTasas(module.exports, {
    cronExpression: cronConfig.verificacion.matutina,
    taskId: 'verificacion-tasas-matutina',
    soloTasasActivas: true,
    enviarEmail: true,
    notificarExito: true, // Enviar email incluso cuando todo está bien
    emailDestinatario: "cerramaximiliano@gmail.com"
  });

  // Verificación después de cada ciclo de actualización
  programarVerificacionTasas(module.exports, {
    cronExpression: cronConfig.verificacion.ciclica,
    taskId: 'verificacion-tasas-ciclica',
    soloTasasActivas: true,
    enviarEmail: true,
    notificarExito: false, // No notificar éxito en las verificaciones cíclicas (sería demasiado frecuente)
    emailDestinatario: "cerramaximiliano@gmail.com"
  });

  // Verificación diaria completa
  programarVerificacionTasas(module.exports, {
    cronExpression: cronConfig.verificacion.diaria,
    taskId: 'verificacion-tasas-diaria',
    soloTasasActivas: false, // Verificar todas las tasas, incluso las inactivas
    enviarEmail: true,
    notificarExito: true, // Enviar email incluso cuando todo está bien
    emailDestinatario: "cerramaximiliano@gmail.com"
  });

  // Registrar este servicio en la utilidad de base de datos
  // para permitir la reinicialización automática en caso de reconexión
  if (typeof database.registerTaskService === 'function') {
    database.registerTaskService(module.exports);
  }

  logger.info(`Se inicializaron ${tasks.size} tareas programadas`);
}

module.exports = {
  scheduleTask,
  stopTask,
  startTask,
  executeTaskNow,
  getTasksList,
  initializeTasks,
  stopAllTasks
};