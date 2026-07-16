// server/services/stats/statsSyncService.js
const mongoose = require('mongoose');
const logger = require('../../utils/logger');


// Nombres de colecciones
const COLLECTIONS = {
  users: 'usuarios',
  stats: 'userstats',
  calculators: 'calculators',
  folders: 'folders',
  movements: 'movements',
  notifications: 'notifications',
  events: 'events',
  contacts: 'contacts',
};

/**
 * Verifica y repara contadores negativos
 * @returns {Promise<Object>} Resultado de la operación
 */
async function repairNegativeCounters() {
  try {
    // Verificar conexión a MongoDB
    if (mongoose.connection.readyState !== 1) {
      logger.error('No hay conexión a MongoDB para reparar contadores negativos');
      return { repaired: 0, error: 'Sin conexión' };
    }

    const statsCollection = mongoose.connection.collection(COLLECTIONS.stats);
    
    // Obtener todas las estadísticas
    const stats = await statsCollection.find({}).toArray();
    logger.info(`Verificando contadores negativos para ${stats.length} usuarios`);
    
    let repairCount = 0;
    
    for (const userStat of stats) {
      let needsUpdate = false;
      const updatedCounts = { ...(userStat.counts || {}) };
      
      // Comprobar cada contador
      const archivedCollections = ['folders', 'calculators', 'contacts'];

      for (const [entityType, count] of Object.entries(updatedCounts)) {
        if (count < 0) {
          logger.warn(`Contador negativo detectado: ${entityType} = ${count} para usuario ${userStat.userId}`);

          // Obtener el recuento real de la colección correspondiente
          // Extraer el nombre de la colección (sin el sufijo "Total" si existe)
          const collectionName = entityType.replace(/Total$/, '');

          if (COLLECTIONS[collectionName]) {
            const collection = mongoose.connection.collection(COLLECTIONS[collectionName]);
            const userId = userStat.userId;
            // Convertir a ObjectId si es necesario
            const userIdForQuery = typeof userId === 'string'
              ? new mongoose.Types.ObjectId(userId)
              : userId;

            let actualCount;

            // Si es un contador Total o si la colección no debe filtrar, contar todos
            if (entityType.endsWith('Total') || !archivedCollections.includes(collectionName)) {
              const filter = { userId: userIdForQuery };

              // Para calculators, solo contar tipo "Calculado"
              if (collectionName === 'calculators') {
                filter.type = 'Calculado';
              }

              actualCount = await collection.countDocuments(filter);
            } else {
              // Si es folders, calculators o contacts, contar solo activos
              const filter = {
                userId: userIdForQuery,
                archived: false
              };

              // Para calculators, solo contar tipo "Calculado"
              if (collectionName === 'calculators') {
                filter.type = 'Calculado';
              }

              actualCount = await collection.countDocuments(filter);
            }

            updatedCounts[entityType] = actualCount;
            needsUpdate = true;
            repairCount++;

            logger.info(`Contador ${entityType} corregido: ${count} → ${actualCount}`);
          }
        }
      }
      
      // Actualizar si es necesario
      if (needsUpdate) {
        await statsCollection.updateOne(
          { _id: userStat._id },
          { 
            $set: { 
              counts: updatedCounts,
              lastUpdated: new Date()
            } 
          }
        );
        logger.info(`Contadores reparados para usuario ${userStat.userId}`);
      }
    }
    
    logger.info(`Reparación completada. Se corrigieron ${repairCount} contadores negativos.`);
    return { repaired: repairCount };
  } catch (error) {
    logger.error(`Error al reparar contadores negativos: ${error.message}`);
    return { repaired: 0, error: error.message };
  }
}

/**
 * Actualiza las estadísticas para un usuario específico
 * @param {string} userId - ID del usuario
 * @returns {Promise<boolean>} Resultado de la operación
 */
async function updateUserStats(userId) {
  try {
    if (!userId) {
      logger.warn('Se intentó actualizar estadísticas sin proporcionar userId');
      return false;
    }
    
    // Verificar conexión a MongoDB
    if (mongoose.connection.readyState !== 1) {
      logger.error('No hay conexión a MongoDB para actualizar estadísticas');
      return false;
    }
    
    // Verificar si el usuario existe
    const usersCollection = mongoose.connection.collection(COLLECTIONS.users);
    const userIdObj = typeof userId === 'string' 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;
    
    const userExists = await usersCollection.findOne({ _id: userIdObj });
    
    if (!userExists) {
      logger.warn(`Usuario con ID ${userId} no encontrado`);
      return false;
    }
    
    // Calcular contadores para cada tipo de entidad
    const counts = {};

    // Colecciones que deben filtrar por archived: false
    const archivedCollections = ['folders', 'calculators', 'contacts'];

    // Obtener contadores en paralelo
    const countPromises = Object.entries(COLLECTIONS)
      .filter(([name]) => name !== 'users' && name !== 'stats')
      .map(async ([name, collection]) => {
        try {
          // Para folders, calculators y contacts: contar solo activos (archived: false)
          if (archivedCollections.includes(name)) {
            // Filtro base para activos
            const activeFilter = {
              userId: userIdObj,
              archived: false
            };

            // Para calculators, solo contar tipo "Calculado"
            if (name === 'calculators') {
              activeFilter.type = 'Calculado';
            }

            const activeCount = await mongoose.connection.collection(collection).countDocuments(activeFilter);
            counts[name] = activeCount;

            // También contar TODOS (activos + archivados) para el campo Total
            const totalFilter = { userId: userIdObj };

            // Para calculators, solo contar tipo "Calculado"
            if (name === 'calculators') {
              totalFilter.type = 'Calculado';
            }

            const totalCount = await mongoose.connection.collection(collection).countDocuments(totalFilter);
            counts[`${name}Total`] = totalCount;
          } else {
            // Para otras colecciones, contar todos sin filtro
            const count = await mongoose.connection.collection(collection).countDocuments({
              userId: userIdObj
            });
            counts[name] = count;
          }
          return true;
        } catch (error) {
          logger.error(`Error al contar ${name}: ${error.message}`);
          counts[name] = 0;
          if (archivedCollections.includes(name)) {
            counts[`${name}Total`] = 0;
          }
          return false;
        }
      });

    await Promise.all(countPromises);

    // Actualizar estadísticas con dot-notation POR CLAVE: reemplazar el objeto `counts`
    // entero borraba los contadores que este servicio NO recalcula y que law-analytics-server
    // mantiene transaccionalmente (counts.postalDocuments — límite de escritos por plan —,
    // counts.postalTrackings y counts.alerts), reseteando el límite cada madrugada.
    const setQuery = { lastUpdated: new Date() };
    for (const [key, value] of Object.entries(counts)) {
      setQuery[`counts.${key}`] = value;
    }
    const statsCollection = mongoose.connection.collection(COLLECTIONS.stats);
    await statsCollection.updateOne(
      { userId: userIdObj },
      { $set: setQuery },
      { upsert: true }
    );
    
    logger.info(`Estadísticas actualizadas para usuario ${userId}`);
    return true;
  } catch (error) {
    logger.error(`Error al actualizar estadísticas para usuario ${userId}: ${error.message}`);
    return false;
  }
}

/**
 * Actualiza las estadísticas para todos los usuarios
 * @returns {Promise<Object>} Resultado de la operación
 */
async function updateAllUserStats() {
  try {
    // Verificar conexión a MongoDB
    if (mongoose.connection.readyState !== 1) {
      logger.error('No hay conexión a MongoDB para actualizar estadísticas');
      return { success: 0, errors: 0, error: 'Sin conexión' };
    }
    
    const usersCollection = mongoose.connection.collection(COLLECTIONS.users);
    
    // Obtener todos los usuarios
    const users = await usersCollection.find({}).toArray();
    logger.info(`Iniciando actualización de estadísticas para ${users.length} usuarios`);
    
    let successCount = 0;
    let errorCount = 0;
    
    // Procesar usuarios en lotes
    const batchSize = 20;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      
      // Actualizar cada usuario en el lote
      const promises = batch.map(user => updateUserStats(user._id.toString()));
      const results = await Promise.all(promises.map(p => p.catch(e => {
        logger.error(e);
        return false;
      })));
      
      // Contar resultados
      successCount += results.filter(result => result === true).length;
      errorCount += results.filter(result => result === false).length;
      
      logger.info(`Procesado lote ${Math.floor(i/batchSize) + 1}/${Math.ceil(users.length/batchSize)}`);
    }
    
    logger.info(`Actualización completada. Éxitos: ${successCount}, Errores: ${errorCount}`);
    return { success: successCount, errors: errorCount };
  } catch (error) {
    logger.error(`Error al actualizar estadísticas: ${error.message}`);
    return { success: 0, errors: 0, error: error.message };
  }
}

/**
 * Ejecuta una sincronización completa de estadísticas
 * @returns {Promise<Object>} Resultado de la operación
 */
async function syncAllStats() {
  try {
    // Verificar conexión a MongoDB
    if (mongoose.connection.readyState !== 1) {
      const error = 'No hay conexión activa a MongoDB para sincronizar estadísticas';
      logger.error(error);
      return { error };
    }
    
    // Reparar contadores negativos
    logger.info('Reparando contadores negativos...');
    const repairResult = await repairNegativeCounters();
    
    // Actualizar todas las estadísticas
    logger.info('Actualizando estadísticas de todos los usuarios...');
    const updateResult = await updateAllUserStats();
    
    logger.info('Sincronización completa de estadísticas finalizada');
    return {
      repaired: repairResult.repaired,
      updated: updateResult
    };
  } catch (error) {
    logger.error(`Error en sincronización de estadísticas: ${error.message}`);
    return { error: error.message };
  }
}

/**
 * Verifica el estado actual de la sincronización
 * @returns {Object} Estado de la sincronización
 */
function getStatus() {
  return {
    dbConnected: mongoose.connection.readyState === 1,
    collections: COLLECTIONS,
    lastRun: null // Podrías almacenar la última ejecución en una variable global o en la base de datos
  };
}

module.exports = {
  repairNegativeCounters,
  updateUserStats,
  updateAllUserStats,
  syncAllStats,
  getStatus
};