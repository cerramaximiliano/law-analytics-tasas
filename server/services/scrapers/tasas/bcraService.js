const TasasConfig = require("../../../models/tasasConfig");
const Tasas = require("../../../models/tasas");
const { verificarFechasFaltantes } = require('../../../controllers/tasasController')
const axios = require("axios")
const logger = require('../../../utils/logger');
const moment = require("moment")

/**
 * Registra un error en el modelo TasasConfig
 * 
 * @param {String} tipoTasa - Tipo de tasa afectada
 * @param {String} taskId - Identificador de la tarea
 * @param {String} mensaje - Mensaje de error
 * @param {String|Object} detalleError - Detalles adicionales del error
 * @param {String} codigo - Código de error opcional
 * @returns {Promise<boolean>} - Resultado del registro
 */
async function registrarErrorTasa(tipoTasa, taskId, mensaje, detalleError = '', codigo = '') {
    try {
        if (!tipoTasa) {
            logger.warn(`No se puede registrar error: tipoTasa no proporcionado`);
            return false;
        }
        
        const config = await TasasConfig.findOne({ tipoTasa });
        if (!config) {
            logger.warn(`No se puede registrar error: configuración no encontrada para ${tipoTasa}`);
            return false;
        }
        
        await config.registrarError(taskId, mensaje, detalleError, codigo);
        return true;
    } catch (error) {
        logger.error(`Error al registrar error en TasasConfig: ${error.message}`);
        return false;
    }
}

/**
 * Actualiza la configuración de fechas para un tipo de tasa
 * 
 * @param {String} tipoTasa - Tipo de tasa
 * @returns {Promise<Object>} - Configuración actualizada
 */
async function actualizarConfiguracion(tipoTasa) {
    // Buscar la última fecha disponible en la base de datos
    const ultimoRegistro = await Tasas.findOne({ [tipoTasa]: { $ne: null } })
        .sort({ fecha: -1 })
        .select('fecha');

    if (!ultimoRegistro) {
        return null;
    }

    const fechaUltima = moment.utc(ultimoRegistro.fecha).startOf('day').toDate();

    // Actualizar configuración
    const config = await TasasConfig.findOne({ tipoTasa });

    if (config) {
        // Solo actualizar si la nueva fecha es más reciente
        if (!config.fechaUltima || fechaUltima > config.fechaUltima) {
            config.fechaUltima = fechaUltima;
            config.ultimaVerificacion = new Date();
            await config.save();
        }
        return config;
    }

    // Si no existe la configuración, crearla
    const primeraFecha = await Tasas.findOne({ [tipoTasa]: { $ne: null } })
        .sort({ fecha: 1 })
        .select('fecha');

    const nuevaConfig = new TasasConfig({
        tipoTasa,
        fechaInicio: moment.utc(primeraFecha.fecha).startOf('day').toDate(),
        fechaUltima: fechaUltima,
        fechaUltimaCompleta: fechaUltima,
        fechasFaltantes: [],
        ultimaVerificacion: new Date()
    });

    await nuevaConfig.save();
    return nuevaConfig;
}


/**
 * Agrupa fechas consecutivas en rangos para optimizar las consultas a la API
 * 
 * @param {Array<Date>} fechas - Lista de fechas a agrupar
 * @returns {Array<Object>} - Lista de rangos de fechas
 */
function agruparFechasConsecutivas(fechas) {
    // Si no hay fechas, retornar array vacío
    if (!fechas || !fechas.length) {
        return [];
    }

    // Ordenar fechas
    const fechasOrdenadas = [...fechas].sort((a, b) => a - b);

    const rangos = [];
    let rangoActual = {
        desde: fechasOrdenadas[0],
        hasta: fechasOrdenadas[0],
        dias: 1
    };

    for (let i = 1; i < fechasOrdenadas.length; i++) {
        const fechaActual = fechasOrdenadas[i];
        const fechaAnterior = fechasOrdenadas[i - 1];

        // Calcular diferencia en días
        const diff = moment(fechaActual).diff(moment(fechaAnterior), 'days');

        if (diff <= 1) {
            // Es consecutiva, extender el rango actual
            rangoActual.hasta = fechaActual;
            rangoActual.dias++;
        } else {
            // No es consecutiva, cerrar el rango actual y crear uno nuevo
            rangos.push(rangoActual);
            rangoActual = {
                desde: fechaActual,
                hasta: fechaActual,
                dias: 1
            };
        }
    }

    // Añadir el último rango
    rangos.push(rangoActual);

    return rangos;
}


/**
 * Procesa y guarda los datos obtenidos de la API del BCRA en la base de datos
 * 
 * @param {String} tipoTasa - Tipo de tasa a guardar (ej: 'tasaPasivaBCRA')
 * @param {Array} datos - Datos obtenidos de la API
 * @returns {Promise<Object>} - Resultado del procesamiento
 */
async function procesarDatosBCRA(tipoTasa, datos) {
    try {
        if (!datos || !Array.isArray(datos) || datos.length === 0) {
            return {
                status: 'error',
                message: 'No hay datos para procesar'
            };
        }

        logger.info(`Procesando ${datos.length} registros de la API del BCRA para ${tipoTasa}`);

        const resultados = {
            total: datos.length,
            creados: 0,
            actualizados: 0,
            errores: 0,
            fechasProcesadas: []
        };

        // Iterar sobre cada registro y guardarlo en la base de datos
        for (const dato of datos) {
            try {
                // Verificar si el dato tiene la estructura esperada
                if (!dato.fecha || !dato.valor) {
                    logger.warn(`Dato con estructura inválida: ${JSON.stringify(dato)}`);
                    resultados.errores++;
                    continue;
                }

                // Convertir fecha a objeto Date (normalizado a UTC)
                const fecha = moment.utc(dato.fecha, 'YYYY-MM-DD').startOf('day').toDate();
                const valor = parseFloat(dato.valor);


                if (isNaN(valor)) {
                    logger.warn(`Valor no numérico para fecha ${dato.fecha}: ${dato.valor}`);
                    resultados.errores++;
                    continue;
                }

                // Buscar si ya existe un registro para esta fecha
                const existente = await Tasas.findOne({ fecha });

                if (existente) {
                    // Actualizar registro existente
                    existente[tipoTasa] = valor;
                    await existente.save();
                    resultados.actualizados++;
                } else {
                    // Crear nuevo registro
                    const nuevoRegistro = new Tasas({
                        fecha,
                        [tipoTasa]: valor
                    });

                    await nuevoRegistro.save();
                    resultados.creados++;
                }

                resultados.fechasProcesadas.push({
                    fecha,
                    fechaFormateada: moment.utc(fecha).format('YYYY-MM-DD'),
                    valor
                });

            } catch (datoError) {
                // Si es error de fusión de registros, considerarlo como actualización exitosa
                if (datoError.message === 'MERGED_WITH_EXISTING') {
                    resultados.actualizados++;
                } else {
                    logger.error(`Error al procesar dato: ${datoError.message}`);
                    resultados.errores++;
                }
            }
        }

        // Actualizar configuración si se procesaron datos
        if (resultados.creados > 0 || resultados.actualizados > 0) {
            try {
                await actualizarConfiguracion(tipoTasa);
            } catch (configError) {
                logger.warn(`Error al actualizar configuración: ${configError.message}`);
            }
        }

        return {
            status: 'success',
            message: `Procesamiento completado: ${resultados.creados} creados, ${resultados.actualizados} actualizados, ${resultados.errores} errores`,
            data: resultados
        };

    } catch (error) {
        logger.error(`Error al procesar datos del BCRA: ${error.message}`);
        return {
            status: 'error',
            message: `Error al procesar datos: ${error.message}`
        };
    }
};

/**
 * Consulta datos históricos de la API del BCRA para una variable y rango de fechas específico
 * 
 * @param {String} idVariable - ID de la variable a consultar en la API del BCRA
 * @param {Date} fechaDesde - Fecha de inicio en formato Date
 * @param {Date} fechaHasta - Fecha de fin en formato Date
 * @param {String} tipoTasa - Tipo de tasa para registro de errores (opcional)
 * @returns {Promise<Object>} - Resultado de la consulta
 */
async function consultarBCRA(idVariable, fechaDesde, fechaHasta, tipoTasa = null) {
    try {
        // Formatear fecha desde a YYYY-MM-DD para la API
        const desde = moment.utc(fechaDesde).format('YYYY-MM-DD');
        
        // Construir los parámetros de la URL
        let params = `desde=${desde}`;
        
        // Solo añadir el parámetro fechaHasta si tiene valor
        if (fechaHasta) {
            const hasta = moment.utc(fechaHasta).format('YYYY-MM-DD');
            params += `&hasta=${hasta}`;
            logger.info(`Consultando API BCRA para variable ${idVariable} desde ${desde} hasta ${hasta}`);
        } else {
            logger.info(`Consultando API BCRA para variable ${idVariable} desde ${desde} sin fecha de fin`);
        }
        
        // Construir URL de la API
        const url = `https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/${idVariable}?${params}`;
        
        // Realizar petición a la API con la opción de deshabilitar la verificación SSL
        const response = await axios.get(url, {
            headers: {
                'Accept': 'application/json'
                // Agregar cualquier otra cabecera necesaria, como autorización si la API lo requiere
            },
            timeout: 15000, // 15 segundos de timeout
            httpsAgent: new (require('https').Agent)({
                rejectUnauthorized: false // Deshabilita la verificación de certificados SSL
            })
        });
        
        // Verificar respuesta exitosa
        if (response.status !== 200) {
            const errorMsg = `Error en la API del BCRA: ${response.status} - ${response.statusText}`;
            
            // Registrar error si se especificó tipoTasa
            if (tipoTasa) {
                await registrarErrorTasa(
                    tipoTasa,
                    `bcra-api-${idVariable}`,
                    errorMsg,
                    JSON.stringify(response.data || {}),
                    `HTTP_${response.status}`
                );
            }
            
            throw new Error(errorMsg);
        }
        
        // En la API v4.0, los datos están en results[0].detalle (array de {fecha, valor})
        const resultados = response.data.results;
        const datos = (resultados && resultados.length > 0 && resultados[0].detalle)
            ? resultados[0].detalle
            : [];

        logger.info(`Respuesta exitosa de API BCRA: ${datos.length} registros obtenidos`);

        // Si había errores previos para este tipo de tasa y API, resolverlos
        if (tipoTasa) {
            const config = await TasasConfig.findOne({ tipoTasa });
            if (config) {
                await config.resolverErrores(`bcra-api-${idVariable}`);
            }
        }

        return {
            status: 'success',
            message: `Datos obtenidos correctamente de la API del BCRA para ${idVariable}`,
            data: datos
        };
    } catch (error) {
        logger.error(`Error al consultar API del BCRA: ${error.message}`);
        
        // Registrar error si se especificó tipoTasa
        if (tipoTasa) {
            await registrarErrorTasa(
                tipoTasa,
                `bcra-api-${idVariable}`,
                `Error al consultar API del BCRA: ${error.message}`,
                error.stack || JSON.stringify(error),
                error.code || 'API_ERROR'
            );
        }
        
        // Determinar tipo de error
        let errorMessage = error.message;
        let errorType = 'general';
        
        if (error.response) {
            // Error de respuesta HTTP
            errorMessage = `Error ${error.response.status}: ${error.response.statusText || 'Sin mensaje'}`;
            errorType = 'http';
        } else if (error.request) {
            // Error de conexión
            errorMessage = 'No se pudo conectar con la API del BCRA';
            errorType = 'connection';
        }
        
        return {
            status: 'error',
            errorType,
            message: errorMessage,
            error: error.message
        };
    }
}


/**
 * Consulta la tasa de la fecha actual en la API del BCRA y la guarda en la base de datos
 * 
 * @param {String} tipoTasa - Tipo de tasa a consultar (ej: 'tasaPasivaBCRA')
 * @param {String} idVariable - ID de la variable en la API del BCRA
 * @returns {Promise<Object>} - Resultado de la operación
 */
exports.getCurrentRateAndSave = async (tipoTasa, idVariable) => {
    try {
        logger.info(`Iniciando consulta de tasa actual para ${tipoTasa} con idVariable=${idVariable}`);
        
        // Obtener la fecha actual (sin hora)
        const fechaActual = moment().startOf('day');
        const fechaActualStr = fechaActual.format('YYYY-MM-DD');
        
        // Verificar si ya existe el registro para la fecha actual
        const existeRegistro = await Tasas.findOne({
            fecha: fechaActual.toDate(),
            [tipoTasa]: { $ne: null }
        });
        
        if (existeRegistro) {
            logger.info(`Ya existe registro para ${tipoTasa} en la fecha ${fechaActualStr} con valor ${existeRegistro[tipoTasa]}`);
            return {
                status: 'success',
                message: 'El registro ya existe en la base de datos',
                data: {
                    fecha: fechaActualStr,
                    valor: existeRegistro[tipoTasa],
                    esNuevo: false
                }
            };
        }
        
        // Consultar la API del BCRA para la fecha actual
        logger.info(`Consultando tasa para fecha actual: ${fechaActualStr}`);
        
        // Usar la función consultarBCRA existente
        const fechaActualDate = fechaActual.toDate();
        const consultaResult = await consultarBCRA(idVariable, fechaActualDate);
        
        if (consultaResult.status !== 'success') {
            logger.warn(`Error al consultar API BCRA: ${consultaResult.message}`);
            return {
                status: 'error',
                message: `Error al consultar la API del BCRA: ${consultaResult.message}`,
                errorType: consultaResult.errorType || 'general',
                data: {
                    fecha: fechaActualStr,
                    consultado: true,
                    disponible: false,
                    error: consultaResult.error
                }
            };
        }
        
        // Verificar si hay resultados
        const resultados = consultaResult.data;
        
        if (!resultados || !Array.isArray(resultados) || resultados.length === 0) {
            logger.warn(`No hay datos disponibles para la fecha ${fechaActualStr}`);
            return {
                status: 'warning',
                message: `No hay datos disponibles para la fecha ${fechaActualStr}`,
                data: {
                    fecha: fechaActualStr,
                    consultado: true,
                    disponible: false
                }
            };
        }
        
        // Procesar los datos usando la función existente
        const procesamientoResult = await procesarDatosBCRA(tipoTasa, resultados);
        
        if (procesamientoResult.status !== 'success') {
            logger.warn(`Error al procesar datos: ${procesamientoResult.message}`);
            return {
                status: 'error',
                message: `Error al procesar los datos: ${procesamientoResult.message}`,
                data: {
                    fecha: fechaActualStr,
                    consultado: true,
                    procesado: false
                }
            };
        }
        
        // Verificar que se haya procesado al menos un registro
        if (procesamientoResult.data.creados === 0 && procesamientoResult.data.actualizados === 0) {
            logger.warn(`No se pudo guardar ningún registro para la fecha ${fechaActualStr}`);
            return {
                status: 'warning',
                message: 'No se pudo guardar ningún registro',
                data: {
                    fecha: fechaActualStr,
                    consultado: true,
                    procesado: true,
                    guardado: false
                }
            };
        }
        
        // Obtener el valor guardado para incluirlo en la respuesta
        const registroGuardado = await Tasas.findOne({
            fecha: fechaActual.toDate()
        });
        
        return {
            status: 'success',
            message: 'Datos actuales obtenidos y guardados correctamente',
            data: {
                fecha: fechaActualStr,
                valor: registroGuardado ? registroGuardado[tipoTasa] : null,
                esNuevo: procesamientoResult.data.creados > 0,
                actualizado: procesamientoResult.data.actualizados > 0,
                registroId: registroGuardado ? registroGuardado._id : null,
                detallesProcesamiento: procesamientoResult.data
            }
        };
        
    } catch (error) {
        logger.error(`Error al consultar tasa actual: ${error.message}`);
        
        return {
            status: 'error',
            message: `Error al consultar tasa actual: ${error.message}`,
            data: {
                fecha: moment().startOf('day').format('YYYY-MM-DD'),
                error: error.message
            }
        };
    }
};

exports.findMissingDataServiceBcra = async (tipoTasa, idVariable) => {
    try {
        logger.info(`Iniciando proceso para completar fechas faltantes de ${tipoTasa} con idVariable=${idVariable}`);

        // Obtener fechas faltantes
        const verificacion = await verificarFechasFaltantes(tipoTasa);

        if (!verificacion.diasFaltantes) {
            return {
                status: 'success',
                message: 'No hay fechas faltantes para completar',
                data: verificacion
            };
        }

        logger.info(`Se encontraron ${verificacion.diasFaltantes} fechas faltantes para ${tipoTasa}`);

        // Preparar las fechas faltantes agrupadas por rangos consecutivos
        const rangos = agruparFechasConsecutivas(verificacion.fechasFaltantes.map(f => f.fecha));

        const resultados = {
            rangos: rangos.length,
            consultasExitosas: 0,
            consultasConError: 0,
            registrosCreados: 0,
            registrosActualizados: 0,
            errores: 0,
            detalleRangos: []
        };

        // Procesar cada rango de fechas
        for (const rango of rangos) {
            try {
                logger.info(`Consultando rango: ${moment.utc(rango.desde).format('YYYY-MM-DD')} a ${moment.utc(rango.hasta).format('YYYY-MM-DD')}`);

                // Consultar API del BCRA
                const consultaResult = await consultarBCRA(idVariable, rango.desde, rango.hasta);

                const detalleRango = {
                    desde: moment.utc(rango.desde).format('YYYY-MM-DD'),
                    hasta: moment.utc(rango.hasta).format('YYYY-MM-DD'),
                    dias: rango.dias,
                    status: consultaResult.status
                };

                if (consultaResult.status === 'success') {
                    resultados.consultasExitosas++;

                    // Procesar y guardar datos
                    const procesamientoResult = await procesarDatosBCRA(tipoTasa, consultaResult.data);

                    detalleRango.registrosObtenidos = consultaResult.data ? consultaResult.data.length : 0;
                    detalleRango.procesamiento = procesamientoResult.status;

                    if (procesamientoResult.status === 'success') {
                        detalleRango.creados = procesamientoResult.data.creados;
                        detalleRango.actualizados = procesamientoResult.data.actualizados;
                        detalleRango.errores = procesamientoResult.data.errores;

                        resultados.registrosCreados += procesamientoResult.data.creados;
                        resultados.registrosActualizados += procesamientoResult.data.actualizados;
                        resultados.errores += procesamientoResult.data.errores;
                    } else {
                        detalleRango.error = procesamientoResult.message;
                        resultados.errores++;
                    }
                } else {
                    resultados.consultasConError++;
                    detalleRango.error = consultaResult.message;
                }

                resultados.detalleRangos.push(detalleRango);

            } catch (rangoError) {
                logger.error(`Error al procesar rango de fechas: ${rangoError.message}`);
                resultados.consultasConError++;
                resultados.errores++;

                resultados.detalleRangos.push({
                    desde: moment.utc(rango.desde).format('YYYY-MM-DD'),
                    hasta: moment.utc(rango.hasta).format('YYYY-MM-DD'),
                    dias: rango.dias,
                    status: 'error',
                    error: rangoError.message
                });
            }

            // Esperar un tiempo entre consultas para no sobrecargar la API
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Volver a verificar fechas faltantes
        const verificacionFinal = await verificarFechasFaltantes(tipoTasa);

        // Determinar el estado real del proceso basado en los resultados
        const status = resultados.consultasConError > 0 && resultados.consultasExitosas === 0 ? 'warning' : 'success';
        const message = resultados.consultasConError > 0
            ? `Proceso completado con advertencias: ${resultados.registrosCreados} registros creados, ${resultados.registrosActualizados} actualizados, ${resultados.consultasConError} consultas con error`
            : `Proceso completado: ${resultados.registrosCreados} registros creados, ${resultados.registrosActualizados} actualizados`;

        return {
            status,
            message,
            data: {
                ...resultados,
                verificacionInicial: verificacion,
                verificacionFinal: verificacionFinal
            }
        };

    } catch (error) {
        logger.error(`Error al completar fechas faltantes: ${error.message}`);
        return {
            status: 'error',
            message: `Error al completar fechas faltantes: ${error.message}`
        };
    }


};