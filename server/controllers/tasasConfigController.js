const Tasas = require("../models/tasas");
const TasasConfig = require("../models/tasasConfig");
const moment = require('moment');
const logger = require('../utils/logger');


/**
 * Controlador para verificar fechas faltantes en un intervalo de fechas para un tipo de tasa
 * @param {string} tipoTasa - Tipo de tasa a verificar
 * @returns {Promise<Object>} - Resultado de la verificación con fechas faltantes
 */
/**
 * Devuelve el estado de actualización de todas las tasas respecto a la fecha actual
 * @route GET /api/tasas/status
 */
exports.getTasasStatus = async (req, res) => {
    try {
        const hoy = moment.utc().startOf('day').toDate();
        const configs = await TasasConfig.find({ discontinuada: { $ne: true } }).select('tipoTasa fechaUltima');

        const total = configs.length;
        const actualizadas = configs.filter(c =>
            c.fechaUltima && moment.utc(c.fechaUltima).startOf('day').isSameOrAfter(moment.utc(hoy))
        ).length;
        const desactualizadas = configs
            .filter(c => !c.fechaUltima || moment.utc(c.fechaUltima).startOf('day').isBefore(moment.utc(hoy)))
            .map(c => ({
                tipoTasa: c.tipoTasa,
                fechaUltima: c.fechaUltima ? moment.utc(c.fechaUltima).format('YYYY-MM-DD') : null,
            }));

        return res.status(200).json({
            success: true,
            data: {
                total,
                actualizadas,
                noActualizadas: total - actualizadas,
                desactualizadas,
                fechaHoy: moment.utc(hoy).format('YYYY-MM-DD'),
            },
        });
    } catch (error) {
        logger.error(`Error en getTasasStatus: ${error.message}`);
        return res.status(500).json({ success: false, mensaje: 'Error al obtener estado de tasas' });
    }
};

exports.verificarFechasFaltantes = async (tipoTasa) => {
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
            'tasaPasivaBP',
            'tasaActivaBPDolares',
            'tasaPasivaBPDolares',
        ];

        if (!tiposValidos.includes(tipoTasa)) {
            throw new Error(`Tipo de tasa inválido: ${tipoTasa}`);
        }

        // Paso 1: Obtener la configuración existente o crearla si no existe
        let config = await TasasConfig.findOne({ tipoTasa });

        if (!config) {
            // Si no existe configuración, encontrar primera y última fecha disponible
            const primeraFecha = await Tasas.findOne({ [tipoTasa]: { $ne: null } })
                .sort({ fecha: 1 })
                .select('fecha');

            const ultimaFecha = await Tasas.findOne({ [tipoTasa]: { $ne: null } })
                .sort({ fecha: -1 })
                .select('fecha');

            if (!primeraFecha || !ultimaFecha) {
                throw new Error(`No hay datos disponibles para el tipo de tasa: ${tipoTasa}`);
            }

            // Crear configuración
            // Normalizamos las fechas a las 00:00:00 UTC
            config = new TasasConfig({
                tipoTasa,
                fechaInicio: moment.utc(primeraFecha.fecha).startOf('day').toDate(),
                fechaUltima: moment.utc(ultimaFecha.fecha).startOf('day').toDate(),
                fechaUltimaCompleta: moment.utc(ultimaFecha.fecha).startOf('day').toDate(),
                fechasFaltantes: []
            });

            await config.save();
        }

        // Paso 2: Generar array de todas las fechas en el intervalo
        // Asegurar que las fechas estén normalizadas a medianoche en UTC
        const fechaInicio = moment.utc(config.fechaInicio).startOf('day');
        let fechaUltima = moment.utc(config.fechaUltima).startOf('day');
        const todasLasFechas = [];

        // Generar array con todas las fechas en el intervalo
        // Cada fecha será a las 00:00:00 UTC
        let fechaActual = moment.utc(fechaInicio);
        while (fechaActual.isSameOrBefore(fechaUltima)) {
            // Usar hora 00:00:00 UTC para todas las fechas
            todasLasFechas.push(fechaActual.clone().startOf('day').toDate());
            fechaActual = fechaActual.clone().add(1, 'days');
        }

        // Paso 3: Buscar fechas existentes en la base de datos
        const fechasExistentes = await Tasas.find({
            fecha: {
                $gte: fechaInicio.toDate(),
                $lte: fechaUltima.toDate()
            },
            [tipoTasa]: { $ne: null }
        }).select('fecha').lean();

        // Crear un mapa de fechas existentes para búsqueda eficiente
        // Usamos el formato YYYY-MM-DD para comparación
        const fechasExistentesMap = new Map();

        fechasExistentes.forEach(item => {
            // Normalizar a UTC y luego tomar solo YYYY-MM-DD
            const fechaKey = moment.utc(item.fecha).format('YYYY-MM-DD');
            fechasExistentesMap.set(fechaKey, item.fecha);
        });

        // Paso 4: Identificar fechas faltantes
        // Comparamos solo la parte de fecha (YYYY-MM-DD), ignorando la hora
        const fechasFaltantesCalculadas = todasLasFechas.filter(fecha => {
            const fechaKey = moment.utc(fecha).format('YYYY-MM-DD');
            return !fechasExistentesMap.has(fechaKey);
        }).map(fecha => moment.utc(fecha).startOf('day').toDate());
        
        // Paso 5: Calcular la fecha más reciente con datos completos
        // Implementamos el algoritmo para encontrar la fechaUltimaCompleta
        // (la última fecha a partir de la cual todos los días tienen datos)
        let fechaUltimaCompleta = null;
        
        if (fechasFaltantesCalculadas.length === 0) {
            // Si no hay fechas faltantes, la fecha última completa es la misma que la fecha última
            fechaUltimaCompleta = config.fechaUltima;
        } else {
            // Ordenamos las fechas faltantes de forma ascendente
            const fechasFaltantesOrdenadas = [...fechasFaltantesCalculadas].sort((a, b) => a - b);
            
            // Si la primera fecha faltante es posterior a la fecha de inicio,
            // entonces todos los datos están completos hasta la fecha faltante - 1 día
            if (fechasFaltantesOrdenadas[0] > config.fechaInicio) {
                const primerFechaFaltante = moment.utc(fechasFaltantesOrdenadas[0]);
                fechaUltimaCompleta = primerFechaFaltante.clone().subtract(1, 'days').toDate();
            } else {
                // Si la primera fecha faltante es la fecha de inicio o anterior,
                // no hay período completo, así que fechaUltimaCompleta es null
                fechaUltimaCompleta = null;
            }
        }
        
        // Paso 6: Actualizar el documento de configuración
        config.fechasFaltantes = fechasFaltantesCalculadas;
        config.fechaUltimaCompleta = fechaUltimaCompleta;
        config.ultimaVerificacion = new Date();
        await config.save();

        // Preparar respuesta
        return {
            tipoTasa,
            fechaInicio: config.fechaInicio,
            fechaUltima: config.fechaUltima,
            fechaUltimaCompleta: config.fechaUltimaCompleta,
            totalDias: todasLasFechas.length,
            diasExistentes: fechasExistentes.length,
            diasFaltantes: fechasFaltantesCalculadas.length,
            fechasFaltantes: fechasFaltantesCalculadas.map(fecha => ({
                fecha,
                fechaFormateada: moment.utc(fecha).format('YYYY-MM-DD')
            })),
            ultimaVerificacion: config.ultimaVerificacion
        };
    } catch (error) {
        logger.error(`Error al verificar fechas faltantes para ${tipoTasa}: ${error.message}`);
        throw error;
    }
};


/**
 * Actualiza el modelo TasasConfig eliminando las fechas que ya han sido procesadas
 * de la propiedad fechasFaltantes.
 * 
 * @param {string} tipoTasa - El tipo de tasa a actualizar
 * @param {Array} fechasProcesadas - Array de objetos con las fechas procesadas ({ fecha: '2024-03-30', values: {...} })
 * @returns {Object} - Resultado de la operación
 */
exports.actualizarFechasFaltantes = async (tipoTasa, fechasProcesadas = []) => {
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
            'tasaPasivaBP',
            'tasaActivaBPDolares',
            'tasaPasivaBPDolares',
        ];

        if (!tiposValidos.includes(tipoTasa)) {
            throw new Error(`Tipo de tasa inválido: ${tipoTasa}`);
        }

        // Validar que se recibió un array de fechas
        if (!Array.isArray(fechasProcesadas)) {
            throw new Error('Se esperaba un array de fechas procesadas');
        }

        // Si no hay fechas para procesar, continuar pero solo para buscar la última fecha en la colección Tasas
        let hayFechasParaProcesar = fechasProcesadas.length > 0;

        // Buscar la configuración para el tipo de tasa
        const config = await TasasConfig.findOne({ tipoTasa });

        if (!config) {
            throw new Error(`No se encontró configuración para el tipo de tasa: ${tipoTasa}`);
        }

        let fechasEliminadas = 0;
        // Variables para rastrear la fecha más reciente y la más antigua del array
        let fechaMasReciente = null;
        let fechaMasAntigua = null;

        // Procesar las fechas faltantes solo si hay fechas para procesar
        if (hayFechasParaProcesar) {
            // Convertir las fechas procesadas de strings a objetos Date
            // y crear un conjunto para búsqueda eficiente
            const fechasProcesadasSet = new Set();

            // Primero identificamos la fecha más antigua y la más reciente en el array de fechasProcesadas
            for (const item of fechasProcesadas) {
                // Convertir la fecha de string a Date
                if (typeof item.fecha === 'string') {
                    // Asegurar formato YYYY-MM-DD y crear fecha UTC a las 00:00:00
                    const [year, month, day] = item.fecha.split('-').map(Number);

                    // Crear fecha UTC (asegura que sea a las 00:00:00)
                    const fechaUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

                    // Añadir al conjunto para búsqueda eficiente
                    // Usar ISOString truncado como clave para evitar problemas de comparación
                    fechasProcesadasSet.add(fechaUTC.toISOString().split('T')[0]);

                    // Actualizar la fecha más reciente
                    if (!fechaMasReciente || fechaUTC > fechaMasReciente) {
                        fechaMasReciente = fechaUTC;
                    }

                    // Actualizar la fecha más antigua
                    if (!fechaMasAntigua || fechaUTC < fechaMasAntigua) {
                        fechaMasAntigua = fechaUTC;
                    }
                }
            }

            // Si hay fechas faltantes, procesarlas
            if (config.fechasFaltantes && config.fechasFaltantes.length > 0) {
                // Filtrar las fechas faltantes para eliminar las procesadas
                const fechasAnteriores = config.fechasFaltantes.length;

                // Filtrar fechas que NO están en el conjunto de procesadas
                config.fechasFaltantes = config.fechasFaltantes.filter(fecha => {
                    // Convertir la fecha a formato YYYY-MM-DD para comparación
                    const fechaStr = fecha.toISOString().split('T')[0];
                    // Mantener la fecha solo si NO está en el conjunto de procesadas
                    return !fechasProcesadasSet.has(fechaStr);
                });

                // Calcular cuántas fechas se eliminaron
                fechasEliminadas = fechasAnteriores - config.fechasFaltantes.length;
            }
        }

        // Actualizar la fecha de última verificación
        config.ultimaVerificacion = new Date();

        // Actualizar fechaInicio y fechaUltima según las fechas procesadas
        if (hayFechasParaProcesar) {
            // Si tenemos una fecha más antigua que la fechaInicio actual (o no hay fechaInicio), actualizarla
            if (fechaMasAntigua && (!config.fechaInicio || fechaMasAntigua < config.fechaInicio)) {
                config.fechaInicio = fechaMasAntigua;
            }

            // Si tenemos una fecha más reciente que la fechaUltima actual (o no hay fechaUltima), actualizarla
            if (fechaMasReciente && (!config.fechaUltima || fechaMasReciente > config.fechaUltima)) {
                config.fechaUltima = fechaMasReciente;
            }
        }

        // NUEVA FUNCIONALIDAD: Buscar la última fecha en la colección Tasas que tenga un valor en la propiedad tipoTasa
        // Crear el filtro para buscar documentos que tengan un valor en la propiedad tipoTasa
        const filtro = { [tipoTasa]: { $exists: true, $ne: null } };

        // Ordenar por fecha en orden descendente y tomar solo el primero (más reciente)
        const ultimaTasa = await Tasas.findOne(filtro).sort({ fecha: -1 });

        // Ordenar por fecha en orden ascendente y tomar solo el primero (más antiguo)
        const primeraTasa = await Tasas.findOne(filtro).sort({ fecha: 1 });

        // Si encontramos una tasa más reciente, actualizar la fechaUltima en la configuración
        if (ultimaTasa && ultimaTasa.fecha) {
            const fechaUltimoRegistro = new Date(ultimaTasa.fecha);
            fechaUltimoRegistro.setUTCHours(0, 0, 0, 0);

            // Actualizar solo si es más reciente que la fecha actual o si no hay fecha actual
            if (!config.fechaUltima || fechaUltimoRegistro > config.fechaUltima) {
                config.fechaUltima = fechaUltimoRegistro;
            }
        }

        // Si encontramos una tasa más antigua, actualizar la fechaInicio en la configuración
        if (primeraTasa && primeraTasa.fecha) {
            const fechaPrimerRegistro = new Date(primeraTasa.fecha);
            fechaPrimerRegistro.setUTCHours(0, 0, 0, 0);

            // Actualizar solo si es más antigua que la fecha actual o si no hay fecha actual
            if (!config.fechaInicio || fechaPrimerRegistro < config.fechaInicio) {
                config.fechaInicio = fechaPrimerRegistro;
            }
        }

        // Calcular la fechaUltimaCompleta
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

        // Guardar los cambios en la base de datos
        await config.save();

        // Retornar el resultado
        return {
            status: 'success',
            message: hayFechasParaProcesar ?
                `Se eliminaron ${fechasEliminadas} fechas de fechasFaltantes y se actualizaron los rangos de fechas` :
                'No se procesaron fechas faltantes, solo se verificaron los rangos de fechas',
            tipoTasa,
            fechasEliminadas,
            fechasRestantes: config.fechasFaltantes ? config.fechasFaltantes.length : 0,
            fechaInicio: config.fechaInicio,
            fechaUltima: config.fechaUltima,
            fechaUltimaCompleta: config.fechaUltimaCompleta,
            fechaInicioActualizada: fechaMasAntigua && config.fechaInicio === fechaMasAntigua,
            fechaUltimaActualizada: ultimaTasa ? true : false,
            fechaUltimaActualizadaDesdeArray: fechaMasReciente && config.fechaUltima === fechaMasReciente
        };
    } catch (error) {
        logger.error(`Error al actualizar fechas faltantes para ${tipoTasa}: ${error.message}`);
        throw error;
    }
};


exports.obtenerTasasConfig = async (req, res) => {
    try {
        // Obtener solo las tasas activas
        const tasas = await TasasConfig.find({ activa: true })
            .select('tipoTasa descripcion fechaInicio fechaUltima fechaUltimaCompleta fechasFaltantes')
            .sort('descripcion');

        // Transformar los datos para el SelectField
        const tasasFormateadas = tasas.map(tasa => ({
            value: tasa.tipoTasa,
            label: formatearNombreTasa(tasa.tipoTasa) || tasa.descripcion,
            fechaInicio: tasa.fechaInicio,
            fechaUltima: tasa.fechaUltima,
            fechaUltimaCompleta: tasa.fechaUltimaCompleta,
            fechasFaltantes: tasa.fechasFaltantes ?? [],
        }));

        return res.status(200).json(tasasFormateadas);
    } catch (error) {
        console.error('Error al obtener tasas:', error);
        return res.status(500).json({ mensaje: 'Error al obtener las tasas' });
    }
};

function formatearNombreTasa(tipoTasa) {
    const formateo = {
        'tasaPasivaBNA': 'Tasa Pasiva Banco Nación',
        'tasaPasivaBCRA': 'Tasa Pasiva BCRA',
        'tasaActivaBNA': 'Tasa Activa Banco Nación',
        'tasaActivaTnaBNA': 'Tasa Activa TNA Banco Nación',
        'cer': 'CER',
        'icl': 'ICL BCRA',
        'tasaActivaCNAT2601': 'Tasa Activa Banco Nación - Acta 2601',
        'tasaActivaCNAT2658': 'Tasa Activa Banco Nación - Acta 2658',
        'tasaActivaCNAT2764': 'Tasa Activa Banco Nación - Acta 2764',
        'tasaPasivaBP':        'Tasa Pasiva Banco Provincia',
        'tasaActivaBPDolares': 'Tasa Activa Banco Provincia en Dólares',
        'tasaPasivaBPDolares': 'Tasa Pasiva Banco Provincia en Dólares',
    };

    return formateo[tipoTasa] || tipoTasa;
}