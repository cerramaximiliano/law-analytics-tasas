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

// Colecciones cuyo contador principal cuenta solo activos (archived: false) y
// que además llevan un contador `<name>Total` con activos + archivados.
const ARCHIVED_COLLECTIONS = ['folders', 'calculators', 'contacts'];

/**
 * Cuenta documentos por usuario para UNA colección, en una sola agregación.
 * Devuelve Map<userIdHex, { count, total? }> con la MISMA semántica que
 * updateUserStats(): solo userId de tipo ObjectId (los string nunca contaron),
 * calculators solo type 'Calculado', y "activo" = archived === false explícito
 * (un doc sin el campo no cuenta como activo, igual que countDocuments({archived:false})).
 */
async function countByUser(name, collectionName) {
  const match = { userId: { $type: 'objectId' } };
  if (name === 'calculators') match.type = 'Calculado';

  const group = { _id: '$userId', total: { $sum: 1 } };
  if (ARCHIVED_COLLECTIONS.includes(name)) {
    group.active = { $sum: { $cond: [{ $eq: ['$archived', false] }, 1, 0] } };
  }

  const rows = await mongoose.connection.collection(collectionName)
    .aggregate([{ $match: match }, { $group: group }], { allowDiskUse: true })
    .toArray();

  const byUser = new Map();
  for (const r of rows) byUser.set(String(r._id), r);
  return byUser;
}

// Respaldo de la colección storageconfig; mismos valores que law-analytics-server/config/storageConfig.js
const STORAGE_SIZES_FALLBACK = { contact: 2048, folder: 10240, folderLinked: 51200, calculator: 5120 };

/** storage.* a partir de lo archivado. Mismo criterio que law-analytics-server/services/storageService.js. */
function storageBytes(archived, sizes) {
  const folders = (archived.foldersLinked || 0) * sizes.folderLinked
    + ((archived.folders || 0) - (archived.foldersLinked || 0)) * sizes.folder;
  const contacts = (archived.contacts || 0) * sizes.contact;
  const calculators = (archived.calculators || 0) * sizes.calculator;
  return { folders, contacts, calculators, total: folders + contacts + calculators };
}

/**
 * Archivados por usuario para el recuento de almacenamiento, en 3 agregaciones.
 * @returns {Promise<Map<string, {folders, foldersLinked, contacts, calculators}>>}
 */
async function archivedByUser() {
  const byUser = new Map();
  const row = (id) => {
    const key = String(id);
    if (!byUser.has(key)) byUser.set(key, {});
    return byUser.get(key);
  };
  const base = { userId: { $type: 'objectId' }, archived: true };
  const db = mongoose.connection;

  const folders = await db.collection(COLLECTIONS.folders).aggregate([
    { $match: base },
    {
      $group: {
        _id: '$userId',
        total: { $sum: 1 },
        linked: {
          $sum: {
            $cond: [{ $and: [{ $gt: ['$causaId', null] }, { $ne: ['$causaIsValid', false] }] }, 1, 0]
          }
        }
      }
    }
  ], { allowDiskUse: true }).toArray();
  for (const r of folders) Object.assign(row(r._id), { folders: r.total, foldersLinked: r.linked });

  const contacts = await db.collection(COLLECTIONS.contacts).aggregate([
    { $match: base }, { $group: { _id: '$userId', total: { $sum: 1 } } }
  ], { allowDiskUse: true }).toArray();
  for (const r of contacts) row(r._id).contacts = r.total;

  const calculators = await db.collection(COLLECTIONS.calculators).aggregate([
    { $match: { ...base, type: 'Calculado' } }, { $group: { _id: '$userId', total: { $sum: 1 } } }
  ], { allowDiskUse: true }).toArray();
  for (const r of calculators) row(r._id).calculators = r.total;

  return byUser;
}

/**
 * Actualiza las estadísticas para todos los usuarios.
 *
 * Una agregación por colección (6 queries en total) en vez de ~8 countDocuments
 * por usuario en paralelo: la versión anterior lanzaba 20 usuarios × 8 counts a
 * la vez y era la ráfaga que inflaba el pool de este proceso hasta ~95 sockets
 * contra Atlas (25/08/2026). Misma salida: cada usuario recibe TODOS sus
 * contadores (0 si no tiene documentos), escritos por clave con dot-notation.
 *
 * @returns {Promise<Object>} { success: usuarios escritos, errors: colecciones que fallaron }
 */
async function updateAllUserStats() {
  try {
    if (mongoose.connection.readyState !== 1) {
      logger.error('No hay conexión a MongoDB para actualizar estadísticas');
      return { success: 0, errors: 0, error: 'Sin conexión' };
    }

    const t0 = Date.now();
    const users = await mongoose.connection.collection(COLLECTIONS.users)
      .find({}, { projection: { _id: 1 } }).toArray();
    logger.info(`Iniciando actualización de estadísticas para ${users.length} usuarios`);

    // 1) Contadores de todas las colecciones, secuencial: una query por colección
    const counted = new Map(); // name -> Map<userIdHex, row>
    let errorCount = 0;
    for (const [name, collectionName] of Object.entries(COLLECTIONS)) {
      if (name === 'users' || name === 'stats') continue;
      try {
        counted.set(name, await countByUser(name, collectionName));
      } catch (error) {
        // Si una colección falla no se escriben sus claves: poner 0 a todos los
        // usuarios por un error transitorio sería peor que dejar el valor anterior.
        logger.error(`Error al contar ${name}: ${error.message}`);
        errorCount++;
      }
    }

    // Almacenamiento: si falla no se escribe (poner 0 por un error transitorio sería peor)
    let archived = null;
    let sizes = STORAGE_SIZES_FALLBACK;
    try {
      archived = await archivedByUser();
      const config = await mongoose.connection.collection('storageconfig').findOne({ isActive: true });
      if (config?.documentSizes) sizes = { ...STORAGE_SIZES_FALLBACK, ...config.documentSizes };
    } catch (error) {
      logger.error(`Error al contar archivados para almacenamiento: ${error.message}`);
      archived = null;
      errorCount++;
    }

    // 2) Un update por usuario, en bulkWrite por chunks. Por clave con dot-notation:
    //    reemplazar `counts` entero borraba postalDocuments/postalTrackings/alerts,
    //    que law-analytics-server mantiene transaccionalmente.
    const statsCollection = mongoose.connection.collection(COLLECTIONS.stats);
    const now = new Date();
    let successCount = 0;
    const CHUNK = 500;
    for (let i = 0; i < users.length; i += CHUNK) {
      const ops = users.slice(i, i + CHUNK).map((user) => {
        const key = String(user._id);
        const setQuery = { lastUpdated: now };
        for (const [name, byUser] of counted) {
          const row = byUser.get(key);
          if (ARCHIVED_COLLECTIONS.includes(name)) {
            setQuery[`counts.${name}`] = row ? row.active : 0;
            setQuery[`counts.${name}Total`] = row ? row.total : 0;
          } else {
            setQuery[`counts.${name}`] = row ? row.total : 0;
          }
        }
        if (archived) {
          const bytes = storageBytes(archived.get(key) || {}, sizes);
          setQuery['storage.folders'] = bytes.folders;
          setQuery['storage.contacts'] = bytes.contacts;
          setQuery['storage.calculators'] = bytes.calculators;
          setQuery['storage.total'] = bytes.total;
        }
        return { updateOne: { filter: { userId: user._id }, update: { $set: setQuery }, upsert: true } };
      });
      if (!ops.length) continue;
      const res = await statsCollection.bulkWrite(ops, { ordered: false });
      successCount += (res.matchedCount || 0) + (res.upsertedCount || 0);
    }

    logger.info(`Actualización completada en ${((Date.now() - t0) / 1000).toFixed(1)}s. Usuarios: ${successCount}, colecciones con error: ${errorCount}`);
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
  storageBytes,
  syncAllStats,
  getStatus
};