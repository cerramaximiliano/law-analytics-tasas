const path = require('path');
const moment = require('moment');
const Tasas = require('../models/tasas');
const logger = require('../utils/logger');
const TasasConfig = require("../models/tasasConfig");
const { main } = require('../services/scrapers/tasas/colegioService');
const { verificarFechasFaltantes, actualizarFechasFaltantes } = require('./tasasConfigController');


/**
 * Obtiene las tasas más recientes para el dashboard
 * 
 * @param {Object} req - Objeto de solicitud Express
 * @param {Object} res - Objeto de respuesta Express
 */
exports.getTasasDashboard = async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 15;

    const tasas = await Tasas.find({
      estado: true,
      fecha: {
        $lte: moment()
      }
    })
      .sort({ fecha: -1 })
      .limit(limit);

    return res.render(path.join(__dirname, '../views/') + 'tasas.ejs', {
      data: tasas
    });
  } catch (error) {
    logger.error(`Error al obtener tasas para dashboard: ${error.message}`);

    return res.status(500).json({
      ok: false,
      status: 500,
      error: 'Error al obtener tasas para dashboard'
    });
  }
};

/**
 * Obtiene las tasas para un período específico
 * 
 * @param {Object} req - Objeto de solicitud Express
 * @param {Object} res - Objeto de respuesta Express
 */
exports.getTasasByPeriod = async (req, res) => {
  try {
    const { startDate, endDate, tipo } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        ok: false,
        status: 400,
        error: 'Los parámetros startDate y endDate son requeridos'
      });
    }

    // Validar fechas
    const start = moment(startDate);
    const end = moment(endDate);

    if (!start.isValid() || !end.isValid()) {
      return res.status(400).json({
        ok: false,
        status: 400,
        error: 'Formato de fecha inválido. Use YYYY-MM-DD'
      });
    }

    // Construir query
    const query = {
      fecha: {
        $gte: start.startOf('day').toDate(),
        $lte: end.endOf('day').toDate()
      }
    };

    // Si se especifica un tipo de tasa, agregar al query
    if (tipo) {
      query[tipo] = { $exists: true, $ne: null };
    }

    // Ejecutar consulta
    const tasas = await Tasas.find(query).sort({ fecha: 1 });

    return res.status(200).json({
      ok: true,
      status: 200,
      count: tasas.length,
      tasas
    });
  } catch (error) {
    logger.error(`Error al obtener tasas por período: ${error.message}`);

    return res.status(500).json({
      ok: false,
      status: 500,
      error: 'Error al obtener tasas por período'
    });
  }
};

/**
 * Obtiene los últimos valores registrados para cada tipo de tasa
 * 
 * @param {Object} req - Objeto de solicitud Express
 * @param {Object} res - Objeto de respuesta Express
 */
exports.getUltimosTasasValues = async (req, res) => {
  try {
    // Tipos de tasas para buscar
    const tiposTasas = [
      'tasaPasivaBCRA',
      'tasaPasivaBNA',
      'tasaActivaBNA',
      'cer',
      'icl',
      'tasaActivaCNAT2601',
      'tasaActivaCNAT2658',
      'tasaActivaCNAT2764',
      'tasaActivaTnaBNA',
    ];

    const result = {};

    // Para cada tipo de tasa, buscar el último valor
    for (const tipo of tiposTasas) {
      const query = {};
      query[tipo] = { $exists: true, $ne: null };

      const tasa = await Tasas.findOne(query)
        .sort({ fecha: -1 })
        .select(`fecha ${tipo}`);

      if (tasa) {
        result[tipo] = {
          fecha: moment(tasa.fecha).format('YYYY-MM-DD'),
          valor: tasa[tipo]
        };
      }
    }

    return res.status(200).json({
      ok: true,
      status: 200,
      tasas: result
    });
  } catch (error) {
    logger.error(`Error al obtener últimos valores de tasas: ${error.message}`);

    return res.status(500).json({
      ok: false,
      status: 500,
      error: 'Error al obtener últimos valores de tasas'
    });
  }
};



exports.getUltimaTasaHastaFecha = async (tipoTasa, fechaMaxima = null, opciones = {}) => {
  try {
    // Validar el tipo de tasa
    const tiposValidos = [
      'tasaPasivaBNA',
      'tasaPasivaBCRA',
      'tasaActivaBNA',
      'cer',
      'icl',
      'tasaActivaCNAT2601',
      'tasaActivaCNAT2658'
    ];

    if (!tiposValidos.includes(tipoTasa)) {
      throw new Error(`Tipo de tasa inválido: ${tipoTasa}`);
    }

    // Construir el filtro base
    const filter = {};
    filter[tipoTasa] = { $ne: null };

    // Si se especifica una fecha máxima, añadirla al filtro
    if (fechaMaxima) {
      const fechaMax = fechaMaxima instanceof Date ? fechaMaxima : new Date(fechaMaxima);
      if (isNaN(fechaMax.getTime())) {
        throw new Error('Fecha máxima inválida');
      }
      filter.fecha = { $lte: fechaMax };
    }

    // Construir la consulta
    let query = Tasas.findOne(filter)
      .sort({ fecha: -1 });

    // Aplicar selección de campos
    if (opciones.incluirCampos) {
      query = query.select(opciones.incluirCampos);
    } else {
      query = query.select(`fecha ${tipoTasa}`);
    }

    // Ejecutar la consulta
    const ultimaTasa = await query;
    if (!ultimaTasa) {
      return null;
    }

    // Formatear el resultado
    const resultado = {
      fecha: ultimaTasa.fecha,
      valor: ultimaTasa[tipoTasa]
    };

    // Si se requiere incluir todos los campos
    if (opciones.incluirDocumentoCompleto) {
      resultado.documento = ultimaTasa;
    }

    return resultado;
  } catch (error) {
    logger.error(`Error al obtener última tasa hasta fecha: ${error.message}`);
    throw error;
  }
};

/**
 * Actualiza o crea múltiples documentos de tasas usando bulkWrite
 * @param {Array} tasasArray - Array de objetos con datos de tasas
 * @returns {Promise<Object>} - Resultado de la operación con contadores
 */
exports.bulkUpsertTasas = async (tasasArray, fuente = null) => {
  try {
    // Validar que se recibió un array
    if (!Array.isArray(tasasArray)) {
      throw new Error('Se esperaba un array de tasas');
    }

    // Mapas para seguimiento de fechas actualizadas/insertadas
    const fechasMap = new Map();

    // Preparar las operaciones de bulkWrite
    const bulkOperations = tasasArray.map(item => {
      // Verificar que el objeto tiene una fecha válida
      if (!item.fecha) {
        throw new Error('Todos los elementos deben tener una fecha válida');
      }

      // Crear objeto Date y formatear para seguimiento
      const fechaObj = new Date(item.fecha);
      const fechaFormatted = fechaObj.toISOString().split('T')[0]; // Formato YYYY-MM-DD

      // Almacenar la fecha para seguimiento
      if (!fechasMap.has(fechaFormatted)) {
        fechasMap.set(fechaFormatted, {
          fecha: fechaObj,
          values: {
            tasaActivaBNA: item.tasaActiva
          }
        });
      }

      // Crear el documento para upsert
      // Mapeando tasaActiva a tasaActivaBNA según el requerimiento
      const doc = {
        fecha: fechaObj, // Asegurar que es un objeto Date
        tasaActivaBNA: item.tasaActiva,
        tasaPasivaBNA: item.tasaPasivaBNA,
      };

      // Registrar fuentes por campo si se proporcionó fuente
      if (fuente) {
        if (item.tasaActiva !== undefined) doc['fuentes.tasaActivaBNA'] = fuente;
        if (item.tasaPasivaBNA !== undefined) doc['fuentes.tasaPasivaBNA'] = fuente;
      }

      // Crear operación de upsert
      return {
        updateOne: {
          filter: { fecha: doc.fecha },
          update: { $set: doc },
          upsert: true
        }
      };
    });

    // Ejecutar la operación de bulk
    const result = await Tasas.bulkWrite(bulkOperations);

    // Arrays para almacenar las fechas insertadas/actualizadas
    const fechasInsertadas = [];
    const fechasActualizadas = [];

    // Procesar fechas insertadas (tenemos los IDs)
    if (result.upsertedIds) {
      // Convertir upsertedIds de un objeto a pares clave-valor
      const upsertedPairs = Object.entries(result.upsertedIds);

      // Para cada id insertado
      for (const [index, id] of upsertedPairs) {
        // Obtener el documento correspondiente de la operación original
        const itemIndex = parseInt(index, 10);
        if (itemIndex >= 0 && itemIndex < bulkOperations.length) {
          const originalDoc = bulkOperations[itemIndex].updateOne.update.$set;
          const fecha = originalDoc.fecha;
          const fechaStr = fecha.toISOString().split('T')[0];

          // Agregar a fechas insertadas con sus valores
          fechasInsertadas.push({
            fecha: fechaStr,
            values: fechasMap.get(fechaStr)?.values || {}
          });
        }
      }
    }

    // Para las actualizaciones, necesitamos hacer una consulta extra
    // Si hubo actualizaciones (matchedCount > upsertedCount)
    if (result.matchedCount > result.upsertedCount) {
      // Obtener todas las fechas que fueron actualizadas
      // Necesitamos un conjunto de fechas para filtrar
      const todasLasFechas = Array.from(fechasMap.values()).map(item => item.fecha);

      // Usamos el conjunto de fechas insertadas para excluirlas
      const fechasInsertadasSet = new Set(fechasInsertadas.map(item => item.fecha));

      // Filtrar fechas que fueron actualizadas (no insertadas)
      const fechasSet = new Set();
      for (const [fechaStr, data] of fechasMap.entries()) {
        if (!fechasInsertadasSet.has(fechaStr)) {
          fechasActualizadas.push({
            fecha: fechaStr,
            values: data.values
          });
          fechasSet.add(fechaStr);
        }
      }
    }

    // Ordenar las fechas
    fechasInsertadas.sort((a, b) => a.fecha.localeCompare(b.fecha));
    fechasActualizadas.sort((a, b) => a.fecha.localeCompare(b.fecha));

    // Preparar los resultados
    const responseData = {
      status: 'success',
      matched: result.matchedCount,
      modified: result.modifiedCount,
      inserted: result.upsertedCount,
      fechasInsertadas: fechasInsertadas,
      fechasActualizadas: fechasActualizadas,
      // Rangos de fechas para facilitar reportes
      rangoInsertado: fechasInsertadas.length > 0 ? {
        desde: fechasInsertadas[0].fecha,
        hasta: fechasInsertadas[fechasInsertadas.length - 1].fecha,
        cantidad: fechasInsertadas.length
      } : null,
      rangoActualizado: fechasActualizadas.length > 0 ? {
        desde: fechasActualizadas[0].fecha,
        hasta: fechasActualizadas[fechasActualizadas.length - 1].fecha,
        cantidad: fechasActualizadas.length
      } : null
    };

    // Crear log informativo
    logger.info(`[${new Date().toISOString()}] BULK_UPSERT_TASAS: Procesados ${bulkOperations.length} registros - Actualizados: ${result.modifiedCount}, Insertados: ${result.upsertedCount}`);

    if (fechasInsertadas.length > 0) {
      logger.info(`Fechas insertadas: ${fechasInsertadas.length} registros, desde ${responseData.rangoInsertado.desde} hasta ${responseData.rangoInsertado.hasta}`);
    }

    if (fechasActualizadas.length > 0) {
      logger.info(`Fechas actualizadas: ${fechasActualizadas.length} registros, desde ${responseData.rangoActualizado.desde} hasta ${responseData.rangoActualizado.hasta}`);
    }

    return responseData;

  } catch (error) {
    logger.error(`Error en bulkUpsertTasas: ${error.message}`);
    throw error;
  }
};




/**
 * Obtiene el rango de fechas faltantes para una tasa específica
 * @param {string} tipoTasa - Tipo de tasa a consultar
 * @param {Object} opciones - Opciones adicionales para la consulta
 * @param {boolean} [opciones.actualizarAntes=false] - Si es true, actualiza las fechas faltantes antes de obtener el rango
 * @param {number} [opciones.limiteDias=null] - Limita el número máximo de días a procesar
 * @returns {Promise<Object>} - Rango de fechas faltantes y detalles para scraping
 */
exports.obtenerRangoFechasFaltantes = async (tipoTasa, opciones = {}) => {
  try {
    // Validar el tipo de tasa
    const tiposValidos = [
      'tasaPasivaBNA',
      'tasaPasivaBCRA',
      'tasaActivaBNA',
      'cer',
      'icl',
      'tasaActivaCNAT2601',
      'tasaActivaCNAT2658',
      'tasaActivaCNAT2764',
      'tasaActivaTnaBNA',

    ];

    if (!tiposValidos.includes(tipoTasa)) {
      throw new Error(`Tipo de tasa inválido: ${tipoTasa}`);
    }

    // Si se solicita actualizar antes, importar y ejecutar el controlador de verificación
    if (opciones.actualizarAntes) {
      await verificarFechasFaltantes(tipoTasa);
    }

    // Buscar la configuración para el tipo de tasa especificado
    const config = await TasasConfig.findOne({ tipoTasa });

    if (!config) {
      throw new Error(`No se encontró configuración para el tipo de tasa: ${tipoTasa}`);
    }

    // Verificar si hay fechas faltantes
    if (!config.fechasFaltantes || config.fechasFaltantes.length === 0) {
      return {
        tipoTasa,
        hayFechasFaltantes: false,
        mensaje: 'No hay fechas faltantes para este tipo de tasa',
        totalFechasFaltantes: 0
      };
    }

    // Ordenar fechas faltantes y asegurar que estén a las 00:00:00 UTC
    const fechasOrdenadas = [...config.fechasFaltantes]
      .sort((a, b) => a - b)
      .map(fecha => {
        // Crear una nueva fecha UTC con año, mes, día y hora a 00:00:00
        const fechaUTC = new Date(Date.UTC(
          fecha.getUTCFullYear(),
          fecha.getUTCMonth(),
          fecha.getUTCDate(),
          0, 0, 0, 0
        ));
        return fechaUTC;
      });

    // Obtener primera y última fecha
    const primeraFechaFaltante = fechasOrdenadas[0];
    const ultimaFechaFaltante = fechasOrdenadas[fechasOrdenadas.length - 1];

    // Calcular días entre la primera y última fecha usando UTC
    const primerDia = moment.utc(primeraFechaFaltante).startOf('day');
    const ultimoDia = moment.utc(ultimaFechaFaltante).startOf('day');
    const diasEnRango = ultimoDia.diff(primerDia, 'days') + 1; // +1 para incluir el día final

    // Aplicar límite de días si está definido
    let fechaDesde = primeraFechaFaltante;
    let fechaHasta = ultimaFechaFaltante;
    let mensaje = `Rango completo de fechas faltantes: ${fechasOrdenadas.length} días`;

    if (opciones.limiteDias && opciones.limiteDias > 0 && opciones.limiteDias < fechasOrdenadas.length) {
      // Calcular fecha límite usando UTC para no afectar la hora
      const limiteDias = Math.min(opciones.limiteDias, fechasOrdenadas.length);
      fechaHasta = new Date(Date.UTC(
        primeraFechaFaltante.getUTCFullYear(),
        primeraFechaFaltante.getUTCMonth(),
        primeraFechaFaltante.getUTCDate() + (limiteDias - 1),
        0, 0, 0, 0
      ));
      mensaje = `Rango limitado a los primeros ${limiteDias} días de ${fechasOrdenadas.length} días faltantes`;
    }

    // Verificar si fechaDesde y fechaHasta son el mismo día, y añadir un día a fechaHasta si es así
    const mismaFecha = moment.utc(fechaDesde).isSame(moment.utc(fechaHasta), 'day');
    if (mismaFecha) {
      // Añadir un día a fechaHasta
      fechaHasta = new Date(Date.UTC(
        fechaHasta.getUTCFullYear(),
        fechaHasta.getUTCMonth(),
        fechaHasta.getUTCDate() + 1,
        0, 0, 0, 0
      ));
      mensaje += ' (se extendió un día adicional al rango para facilitar el procesamiento)';
    }

    // Formatear fechas para la respuesta - asegurar formato UTC 00:00:00
    const fechaDesdeFormateada = moment.utc(fechaDesde).format('YYYY-MM-DD');
    const fechaHastaFormateada = moment.utc(fechaHasta).format('YYYY-MM-DD');

    // Preparar respuesta
    return {
      tipoTasa,
      hayFechasFaltantes: true,
      totalFechasFaltantes: fechasOrdenadas.length,
      fechaDesde,
      fechaHasta,
      fechaDesdeFormateada,
      fechaHastaFormateada,
      diasEnRango: mismaFecha ? diasEnRango + 1 : diasEnRango, // Actualizar días en rango si se añadió un día
      mensaje,
      fechasProcesar: fechasOrdenadas
        .filter(fecha => moment.utc(fecha).isSameOrBefore(fechaHasta))
        .map(fecha => {
          // Garantizar que cada fecha esté en formato UTC 00:00:00
          const fechaUTC = new Date(Date.UTC(
            fecha.getUTCFullYear(),
            fecha.getUTCMonth(),
            fecha.getUTCDate(),
            0, 0, 0, 0
          ));
          return {
            fecha: fechaUTC,
            fechaFormateada: moment.utc(fechaUTC).format('YYYY-MM-DD')
          };
        })
    };
  } catch (error) {
    logger.error(`Error al obtener rango de fechas faltantes para ${tipoTasa}: ${error.message}`);
    throw error;
  }
};

/**
 * Actualiza las tasas en la base de datos
 * @param {Object} data - Datos obtenidos del scraping
 * @param {string} tipoTasa - Tipo de tasa a actualizar (ej: 'tasaActivaBNA')
 * @param {function} calcularValor - Función que calcula el valor a guardar
 * @returns {Promise<Object>} - Resultado de la operación
 */
exports.actualizarTasa = async (data, tipoTasa, calcularValor, tasasAdicionales = [], fuente = null) => {

  try {
    // Verificar si los datos son válidos
    if (!data || !data.data) {
      throw new Error('Datos de tasa inválidos');
    }

    // Obtener fecha del scraping
    const fechaScraping = data.data.fechaVigenciaISO || data.data.fechaFormateada;
    if (!fechaScraping) {
      throw new Error('Fecha de vigencia no encontrada en los datos');
    }

    // Normalizar la fecha usando moment.js, configurando a UTC y principio del día
    const fecha = moment.utc(fechaScraping).startOf('day').toDate();

    // Verificar si la fecha es válida
    if (isNaN(fecha.getTime())) {
      throw new Error(`Fecha inválida: ${fechaScraping}`);
    }

    // Calcular el valor a guardar para la tasa principal
    const valor = calcularValor(data.data);

    // Obtener fecha actual normalizada (UTC, inicio del día)
    const fechaActual = moment.utc().startOf('day').toDate();

    // Verificar si la fecha del scraping es anterior a la fecha actual
    const esAnterior = fecha < fechaActual;

    // Array para almacenar los resultados de las operaciones
    const resultados = [];

    // Preparar un objeto con todos los valores de tasas a guardar
    const valoresParaGuardar = {
      [tipoTasa]: valor
    };

    // Agregar tasas adicionales al objeto de valores
    for (const tasa of tasasAdicionales) {
      valoresParaGuardar[tasa.tipo] = tasa.calcularValor(data.data);
    }

    // Construir mapa de fuentes para todos los campos a guardar
    const fuentes = {};
    if (fuente) {
      fuentes[tipoTasa] = fuente;
      for (const tasa of tasasAdicionales) {
        fuentes[tasa.tipo] = fuente;
      }
    }

    // Guardar/actualizar el registro para la fecha original con todas las tasas
    const resultadoOriginal = await guardarOActualizarTasasMultiples(fecha, valoresParaGuardar, fuentes);
    resultados.push(resultadoOriginal);

    // Si la fecha es anterior a la actual, también guardar/actualizar con la fecha actual
    if (esAnterior) {
      const resultadoActual = await guardarOActualizarTasasMultiples(fechaActual, valoresParaGuardar, fuentes);
      resultados.push(resultadoActual);
      logger.info(`También se actualizaron las tasas para la fecha actual ${moment(fechaActual).format('YYYY-MM-DD')}`);
    }

    // Actualizar la configuración de la tasa principal
    await exports.actualizarConfigTasa(tipoTasa, esAnterior ? fechaActual : fecha);

    // Actualizar configuración de tasas adicionales
    for (const tasa of tasasAdicionales) {
      await exports.actualizarConfigTasa(tasa.tipo, esAnterior ? fechaActual : fecha);
    }

    return {
      actualizado: true,
      mensaje: 'Tasas actualizadas correctamente',
      resultados: resultados,
      valor: valor,
      valoresAdicionales: tasasAdicionales.reduce((obj, tasa) => {
        obj[tasa.tipo] = valoresParaGuardar[tasa.tipo];
        return obj;
      }, {})
    };
  } catch (error) {
    logger.error(`Error al actualizar tasa ${tipoTasa}:`, error);
    throw error;
  }
};

// Nueva función para guardar/actualizar múltiples tasas en un solo documento
async function guardarOActualizarTasasMultiples(fecha, valoresTasas, fuentes = {}) {
  try {
    // Buscar si ya existe un registro para esta fecha
    let documento = await Tasas.findOne({ fecha });

    // Si no existe, crear uno nuevo
    if (!documento) {
      documento = new Tasas({ fecha });
    }

    // Actualizar cada tasa en el documento
    let actualizaciones = [];
    for (const [tipoTasa, valor] of Object.entries(valoresTasas)) {
      // Solo actualizar si el valor es diferente o no existe
      if (documento[tipoTasa] !== valor) {
        documento[tipoTasa] = valor;
        actualizaciones.push(tipoTasa);
      }
    }

    // Registrar la fuente de origen para cada campo actualizado
    if (Object.keys(fuentes).length > 0) {
      if (!documento.fuentes) documento.fuentes = {};
      for (const [campo, fuenteValor] of Object.entries(fuentes)) {
        documento.fuentes[campo] = fuenteValor;
      }
      documento.markModified('fuentes');
    }

    // Si hubo actualizaciones, guardar el documento
    if (actualizaciones.length > 0) {
      await documento.save();
      return {
        fecha: documento.fecha,
        mensaje: `Tasas actualizadas: ${actualizaciones.join(', ')}`,
        actualizado: true,
        valores: valoresTasas
      };
    }

    // Si no hubo actualizaciones
    return {
      fecha: documento.fecha,
      mensaje: 'No hubo cambios en los valores de las tasas',
      actualizado: false,
      valores: valoresTasas
    };
  } catch (error) {
    logger.error(`Error al guardar/actualizar tasas múltiples:`, error);
    throw error;
  }
};

/**
 * Actualiza la tasa activa BNA
 * @param {Object} data - Datos obtenidos del scraping
 * @returns {Promise<Object>} - Resultado de la operación
 */
exports.guardarTasaActivaBNA = async (data, fuente = 'BNA Web') => {
  return await exports.actualizarTasa(
    data,
    'tasaActivaBNA',
    (datos) => {
      // Calcular el valor como TEM / 30
      return datos.tem / 30;
    },
    [
      {
        tipo: 'tasaActivaCNAT2658',
        calcularValor: (datos) => {
          // Calcular el valor como TEA / 365
          return datos.tea / 365;
        }
      },
      {
        tipo: 'tasaActivaTnaBNA',
        calcularValor: (datos) => {
          return datos.tna / 365
        }
      },
      {
        tipo: 'tasaActivaCNAT2764',
        calcularValor: (datos) => {
          return datos.tea / 365;
        }
      }
    ],
    fuente,
  );
};

/**
 * Actualiza la configuración de una tasa específica
 * @param {string} tipoTasa - Tipo de tasa a actualizar
 * @param {Date} fecha - Fecha de la tasa actualizada
 * @returns {Promise<Object>} - Documento de configuración actualizado
 */
exports.actualizarConfigTasa = async (tipoTasa, fecha) => {
  try {
    // Buscar configuración existente
    let config = await TasasConfig.findOne({ tipoTasa: tipoTasa });

    if (config) {
      // Actualizar fecha última
      config.fechaUltima = fecha;
      config.ultimaVerificacion = new Date();
      
      // Verificar si hay fechas faltantes para actualizar fechaUltimaCompleta
      if (config.fechasFaltantes && config.fechasFaltantes.length > 0) {
        // Ordenamos las fechas faltantes de forma ascendente
        const fechasFaltantesOrdenadas = [...config.fechasFaltantes].sort((a, b) => a - b);
        
        // Si la primera fecha faltante es posterior a la fecha de inicio,
        // entonces todos los datos están completos hasta la fecha faltante - 1 día
        if (fechasFaltantesOrdenadas[0] > config.fechaInicio) {
          const primerFechaFaltante = moment.utc(fechasFaltantesOrdenadas[0]);
          config.fechaUltimaCompleta = primerFechaFaltante.clone().subtract(1, 'days').toDate();
        } else {
          // Si la primera fecha faltante es la fecha de inicio o anterior,
          // no hay período completo, así que fechaUltimaCompleta es null
          config.fechaUltimaCompleta = null;
        }
      } else {
        // Si no hay fechas faltantes, la fecha última completa es la misma que la fecha última
        config.fechaUltimaCompleta = config.fechaUltima;
      }
      
      return await config.save();
    } else {
      // Crear nueva configuración
      return await TasasConfig.create({
        tipoTasa: tipoTasa,
        fechaInicio: fecha,
        fechaUltima: fecha,
        fechaUltimaCompleta: fecha, // Si es nueva, asumimos que está completa
        fechasFaltantes: [],
        ultimaVerificacion: new Date()
      });
    }
  } catch (error) {
    logger.error(`Error al actualizar configuración de tasa ${tipoTasa}:`, error);
    throw error;
  }
};


/**
 * Actualiza cualquier tasa con un valor específico
 * @param {Object} data - Datos obtenidos del scraping
 * @param {string} tipoTasa - Tipo de tasa a actualizar
 * @param {number} valor - Valor a guardar
 * @returns {Promise<Object>} - Resultado de la operación
 */
exports.actualizarTasaGeneral = async (data, tipoTasa, valor) => {
  return await this.actualizarTasa(data, tipoTasa, () => valor);
};

/**
 * Controlador que integra el proceso de actualización de tasas y la eliminación de fechas faltantes
 * 
 * @param {string} tipoTasa - Tipo de tasa a procesar
 * @param {Object} resultado - Resultado del proceso de bulkUpsertTasas
 * @returns {Object} - Resultado combinado de la operación
 */
exports.procesarActualizacionTasas = async (tipoTasa, resultado) => {
  logger.info("Inputs procersarActualizacionTasas", tipoTasa, resultado)
  try {
    // Validar que se recibió un resultado válido
    if (!resultado || !resultado.status) {
      throw new Error('No se recibió un resultado válido del proceso de actualización');
    }

    // Unir fechas insertadas y actualizadas
    const todasLasFechasProcesadas = [
      ...(resultado.fechasInsertadas || []),
      ...(resultado.fechasActualizadas || [])
    ];

    // Si no hay fechas procesadas, retornar temprano
    if (todasLasFechasProcesadas.length === 0) {
      return {
        status: 'success',
        message: 'No se procesaron fechas para actualizar',
        resultado
      };
    }

    // Actualizar las fechas faltantes
    const resultadoActualizacion = await this.actualizarFechasFaltantes(tipoTasa, todasLasFechasProcesadas);

    // Combinar resultados
    return {
      status: 'success',
      message: 'Proceso de actualización completado',
      resultado,
      actualizacionFechasFaltantes: resultadoActualizacion
    };
  } catch (error) {
    logger.error(`Error en procesarActualizacionTasas: ${error.message}`);
    throw error;
  }
};


/**
 * Consulta datos por rango de fechas para un campo específico
 * Puede devolver todo el rango o solo los valores extremos según el parámetro 'completo'
 * @param {Object} req - Request
 * @param {Object} res - Response
 * @returns {Object} JSON con los datos solicitados
 */
exports.consultarPorFechas = async (req, res) => {
  try {
    const { fechaDesde, fechaHasta, campo, completo } = req.query;
    // Validar que se proporcionen los parámetros necesarios
    if (!fechaDesde || !fechaHasta || !campo) {
      return res.status(400).json({
        success: false,
        mensaje: 'Se requieren fechaDesde, fechaHasta y campo'
      });
    }

    // Verificar que el campo solicitado sea válido
    const camposValidos = [
      'tasaPasivaBNA', 'tasaPasivaBCRA', 'tasaActivaBNA',
      'cer', 'icl', 'tasaActivaCNAT2601', 'tasaActivaCNAT2658', 'tasaActivaCNAT2764', 'tasaActivaTnaBNA',
    ];

    if (!camposValidos.includes(campo)) {
      return res.status(400).json({
        success: false,
        mensaje: `Campo inválido. Campos permitidos: ${camposValidos.join(', ')}`
      });
    }

    // Validar y transformar fechas en múltiples formatos
    let fechaDesdeNormalizada, fechaHastaNormalizada;

    try {
      // Definir expresiones regulares para validar los diferentes formatos
      const patronesFecha = [
        /^(0[1-9]|[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2]|[1-9])\/\d{4}$/, // DD/MM/YYYY
        /^(0[1-9]|[1-9]|[12]\d|3[01])-(0[1-9]|1[0-2]|[1-9])-\d{4}$/,   // DD-MM-YYYY
        /^\d{4}-(0[1-9]|1[0-2]|[1-9])-(0[1-9]|[1-9]|[12]\d|3[01])$/,   // YYYY-MM-DD
        /^\d{4}\/(0[1-9]|1[0-2]|[1-9])\/(0[1-9]|[1-9]|[12]\d|3[01])$/  // YYYY/MM/DD
      ];

      // Verificar si las fechas coinciden con alguno de los formatos aceptados
      const esDesdeValido = patronesFecha.some(patron => patron.test(fechaDesde));
      const esHastaValido = patronesFecha.some(patron => patron.test(fechaHasta));

      if (!esDesdeValido || !esHastaValido) {
        return res.status(400).json({
          success: false,
          mensaje: 'Las fechas deben tener uno de estos formatos: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD o YYYY/MM/DD'
        });
      }

      // Determinar el formato de la fecha para usar el parser correcto
      let formatoDesde, formatoHasta;

      // Detectar formato para fechaDesde
      if (/^\d{4}/.test(fechaDesde)) {
        // Si empieza con 4 dígitos, es formato YYYY-MM-DD o YYYY/MM/DD
        formatoDesde = fechaDesde.includes('-') ? 'YYYY-MM-DD' : 'YYYY/MM/DD';
      } else {
        // Si no, es formato DD/MM/YYYY o DD-MM-YYYY
        formatoDesde = fechaDesde.includes('/') ? 'DD/MM/YYYY' : 'DD-MM-YYYY';
      }

      // Detectar formato para fechaHasta
      if (/^\d{4}/.test(fechaHasta)) {
        formatoHasta = fechaHasta.includes('-') ? 'YYYY-MM-DD' : 'YYYY/MM/DD';
      } else {
        formatoHasta = fechaHasta.includes('/') ? 'DD/MM/YYYY' : 'DD-MM-YYYY';
      }

      // SOLUCIÓN: Usar el método utc explícitamente y establecer hora, minuto, segundo a 0
      // Esto garantiza que la fecha sea exactamente a medianoche UTC
      fechaDesdeNormalizada = moment.utc(fechaDesde, formatoDesde)
        .set({ hour: 0, minute: 0, second: 0, millisecond: 0 })
        .toDate();

      fechaHastaNormalizada = moment.utc(fechaHasta, formatoHasta)
        .set({ hour: 0, minute: 0, second: 0, millisecond: 0 })
        .toDate();

      // Verificar si las fechas son válidas después de la conversión
      if (!fechaDesdeNormalizada.getTime() || !fechaHastaNormalizada.getTime()) {
        throw new Error('Fechas inválidas después de la conversión');
      }

    } catch (error) {
      return res.status(400).json({
        success: false,
        mensaje: 'Error al procesar las fechas. Asegúrese de que sean fechas válidas en uno de los formatos aceptados.'
      });
    }

    // Seleccionar campos a devolver
    let proyeccion = { fecha: 1, _id: 0 };
    proyeccion[campo] = 1;
    proyeccion[`fuentes.${campo}`] = 1;

    // Ejecutar la consulta según el valor de 'completo'
    let datos;
    const isCompleto = completo === 'true';

    if (isCompleto) {
      // SOLUCIÓN: Ajustar la consulta para buscar exactamente por YYYY-MM-DD
      // Construimos las fechas de inicio/fin del día para la consulta
      const fechaDesdeString = moment.utc(fechaDesdeNormalizada).format('YYYY-MM-DD');
      const fechaHastaString = moment.utc(fechaHastaNormalizada).format('YYYY-MM-DD');

      // Consulta por fechas como strings o usando conversión adecuada según tu schema
      const consulta = {
        $or: [
          // Si la fecha en la base de datos está almacenada como Date
          {
            fecha: {
              $gte: fechaDesdeNormalizada,
              $lte: fechaHastaNormalizada
            }
          },
          // Si la base de datos almacena fechas como strings YYYY-MM-DD
          // (elimina esta parte si no aplica)
          {
            fechaString: {
              $gte: fechaDesdeString,
              $lte: fechaHastaString
            }
          }
        ]
      };

      // Devolver todos los registros dentro del rango
      datos = await Tasas.find(consulta, proyeccion).sort({ fecha: 1 });
    } else {
      // Para búsqueda exacta de un día, usamos una estrategia diferente
      // Creamos consultas que buscan específicamente el día, sin importar la hora

      const fechaDesdeInicio = moment.utc(fechaDesdeNormalizada).startOf('day').toDate();
      const fechaDesdeFin = moment.utc(fechaDesdeNormalizada).endOf('day').toDate();
      const fechaHastaInicio = moment.utc(fechaHastaNormalizada).startOf('day').toDate();
      const fechaHastaFin = moment.utc(fechaHastaNormalizada).endOf('day').toDate();

      // Buscar para fechaDesde
      const registroInicial = await Tasas.findOne(
        { fecha: { $gte: fechaDesdeInicio, $lte: fechaDesdeFin } },
        proyeccion
      ).sort({ fecha: 1 });

      // Buscar para fechaHasta
      const registroFinal = await Tasas.findOne(
        { fecha: { $gte: fechaHastaInicio, $lte: fechaHastaFin } },
        proyeccion
      ).sort({ fecha: 1 });

      datos = {
        inicio: registroInicial,
        fin: registroFinal
      };
    }

    return res.status(200).json({
      success: true,
      datos,
      parametros: {
        fechaDesde: fechaDesdeNormalizada,
        fechaHasta: fechaHastaNormalizada,
        campo,
        completo: isCompleto
      }
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      success: false,
      mensaje: 'Error al consultar datos por fechas',
      error: error.message
    });
  }
};
/**
 * Actualiza el valor de una tasa directamente en la base de datos para una fecha específica
 * @route PUT /api/tasas/valor
 */
exports.actualizarValorDirecto = async (req, res) => {
  try {
    const { fecha, campo, valor } = req.body;

    if (!fecha || !campo || valor === undefined || valor === null) {
      return res.status(400).json({ success: false, mensaje: 'Se requieren fecha, campo y valor' });
    }

    const camposValidos = [
      'tasaPasivaBNA', 'tasaPasivaBCRA', 'tasaActivaBNA',
      'cer', 'icl', 'tasaActivaCNAT2601', 'tasaActivaCNAT2658',
      'tasaActivaCNAT2764', 'tasaActivaTnaBNA',
    ];

    if (!camposValidos.includes(campo)) {
      return res.status(400).json({ success: false, mensaje: `Campo inválido. Permitidos: ${camposValidos.join(', ')}` });
    }

    const valorNumerico = parseFloat(valor);
    if (isNaN(valorNumerico)) {
      return res.status(400).json({ success: false, mensaje: 'El valor debe ser un número válido' });
    }

    const fechaInicio = moment.utc(fecha, 'YYYY-MM-DD').startOf('day').toDate();
    const fechaFin = moment.utc(fecha, 'YYYY-MM-DD').endOf('day').toDate();

    if (isNaN(fechaInicio.getTime())) {
      return res.status(400).json({ success: false, mensaje: 'Fecha inválida. Use formato YYYY-MM-DD' });
    }

    const resultado = await Tasas.findOneAndUpdate(
      { fecha: { $gte: fechaInicio, $lte: fechaFin } },
      { $set: { [campo]: valorNumerico, [`fuentes.${campo}`]: 'Admin Manual' } },
      { new: true, upsert: false }
    );

    if (!resultado) {
      return res.status(404).json({ success: false, mensaje: 'No se encontró registro para esa fecha' });
    }

    logger.info(`[actualizarValorDirecto] ${campo} en ${fecha} actualizado a ${valorNumerico} por ${req.usuario?.email || 'admin'}`);

    return res.status(200).json({
      success: true,
      mensaje: 'Valor actualizado correctamente',
      dato: {
        fecha: moment.utc(resultado.fecha).format('YYYY-MM-DD'),
        campo,
        valor: resultado[campo],
      },
    });
  } catch (error) {
    logger.error(`Error en actualizarValorDirecto: ${error.message}`);
    return res.status(500).json({ success: false, mensaje: 'Error al actualizar el valor' });
  }
};

/**
 * Controlador para actualizar tasas utilizando el scraper
 * @route POST /api/tasas/update
 */
exports.updateTasas = async (req, res) => {
  try {
    // Extraer parámetros obligatorios de la solicitud
    const { tasaId, fechaDesde, fechaHasta, tipoTasa } = req.query;

    // Extraer parámetros opcionales con valores predeterminados
    const dni = process.env.DU_01;
    const tomo = process.env.TREG_01;
    const folio = process.env.FREG_01;
    const screenshot = false;
    const capital = '1000';

    // Validar parámetros obligatorios
    if (!tasaId || !fechaDesde || !fechaHasta || !tipoTasa) {
      return res.status(400).json({
        success: false,
        message: 'Faltan parámetros obligatorios: tasaId, fechaDesde, fechaHasta, tipoTasa'
      });
    }

    // Validar formato de fechas (YYYY-MM-DD)
    const fechaRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!fechaRegex.test(fechaDesde) || !fechaRegex.test(fechaHasta)) {
      return res.status(400).json({
        success: false,
        message: 'Las fechas deben tener formato YYYY-MM-DD'
      });
    }

    // Verificar que fechaDesde sea anterior a fechaHasta
    const fechaDesdeObj = new Date(fechaDesde);
    const fechaHastaObj = new Date(fechaHasta);

    if (fechaDesdeObj > fechaHastaObj) {
      return res.status(400).json({
        success: false,
        message: 'La fecha de inicio debe ser anterior a la fecha final'
      });
    }

    // Convertir fechas de formato ISO (YYYY-MM-DD) a formato DD/MM/YYYY para la función main
    const fechaDesdeArr = fechaDesde.split('-');
    const fechaHastaArr = fechaHasta.split('-');

    const fechaDesdeFormateada = `${fechaDesdeArr[2]}/${fechaDesdeArr[1]}/${fechaDesdeArr[0]}`;
    const fechaHastaFormateada = `${fechaHastaArr[2]}/${fechaHastaArr[1]}/${fechaHastaArr[0]}`;

    // Informar que se inició el proceso
    res.status(202).json({
      success: true,
      message: 'Proceso de actualización de tasas iniciado',
      params: {
        tasaId,
        fechaDesde,
        fechaHasta,
        tipoTasa,
      }
    });

    // Ejecutar el proceso en segundo plano (después de enviar la respuesta)
    await main({
      tasaId,
      dni,
      tomo,
      folio,
      screenshot,
      capital,
      fechaDesde: fechaDesdeFormateada, // Convertida a formato DD/MM/YYYY
      fechaHasta: fechaHastaFormateada, // Convertida a formato DD/MM/YYYY
      tipoTasa
    });

    // Opcionalmente, puedes registrar la finalización en un log
    logger.info(`Proceso de actualización completado para tasaId: ${tasaId}, tipoTasa: ${tipoTasa}`);
  } catch (error) {

    logger.error('Error en controlador updateTasas:', error);

    // No enviamos respuesta aquí porque ya enviamos una respuesta 202 previamente
    // Si quieres manejar esta situación, deberías implementar un sistema de notificación
    // o un endpoint para consultar el estado del proceso
  }
};