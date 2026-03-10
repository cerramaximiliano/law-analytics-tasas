const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const moment = require('moment');
const logger = require('../../../utils/logger');
// Lazy require para evitar dependencia circular con tasasController
// (tasasController → cpacfGapFillerService → bnaService → tasasController)
const getTasasController = () => require('../../../controllers/tasasController');
const { getPuppeteerConfig } = require('../../../config/puppeteer');
const TasasConfig = require('../../../models/tasasConfig');
const Tasas = require('../../../models/tasas');

const configPuppeteer = getPuppeteerConfig();

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
 * Implementa una estrategia de reintentos con backoff exponencial
 * @param {Function} fn - Función a ejecutar con reintentos
 * @param {Object} options - Opciones de configuración
 * @param {number} options.maxRetries - Número máximo de reintentos (default: 3)
 * @param {number} options.initialDelay - Retraso inicial en ms (default: 1000)
 * @param {number} options.maxDelay - Retraso máximo en ms (default: 30000)
 * @param {number} options.factor - Factor de crecimiento (default: 2)
 * @param {Function} options.shouldRetry - Función que evalúa si debe reintentar (default: siempre true)
 * @returns {Promise<any>} - Resultado de la función
 */
async function withRetry(fn, options = {}) {
    const {
        maxRetries = 3,
        initialDelay = 1000,
        maxDelay = 30000,
        factor = 2,
        shouldRetry = () => true,
        onRetry = (error, attempt) => { }
    } = options;

    let attempt = 0;
    let delay = initialDelay;

    while (true) {
        try {
            return await fn(attempt);
        } catch (error) {
            attempt++;

            // Si alcanzamos el número máximo de reintentos, lanzar el error
            if (attempt >= maxRetries || !shouldRetry(error)) {
                throw error;
            }

            // Notificar del reintento
            onRetry(error, attempt);

            // Calcular el próximo delay con jitter (variación aleatoria)
            const jitter = Math.random() * 0.3 + 0.85; // Entre 0.85 y 1.15
            delay = Math.min(delay * factor * jitter, maxDelay);

            // Esperar antes del próximo intento
            logger.info(`Reintento ${attempt}/${maxRetries} en ${Math.round(delay)}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Versión mejorada de extracción de tasas con reintentos
 * @returns {Object} Objeto con fecha y tasas
 */
async function extraerTasaActivaBNAConReintentos(screenshot = false, html = false) {
    let browser;

    return withRetry(
        async (attempt) => {
            try {
                logger.info(`Intento ${attempt + 1} de extracción de tasas del BNA`);

                // Siempre capturar evidencias en reintentos
                const captureScreenshot = screenshot || attempt > 0;
                const captureHTML = html || attempt > 0;

                // Lanzar navegador
                browser = await puppeteer.launch({
                    headless: configPuppeteer.headless,
                    args: configPuppeteer.args,
                    defaultViewport: configPuppeteer.defaultViewport,
                    executablePath: configPuppeteer.executablePath,
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false
                });

                const page = await browser.newPage();
                page.setDefaultNavigationTimeout(60000);

                // Navegar a la página de información financiera del BNA
                const url = 'https://www.bna.com.ar/home/informacionalusuariofinanciero';
                logger.info(`Navegando a: ${url} (intento ${attempt + 1})`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                // Guardar capturas con nombre único que incluya el número de intento
                if (captureScreenshot) {
                    await guardarCaptura(page, `bna-info-financiera-intento-${attempt + 1}`);
                }

                if (captureHTML) {
                    await guardarHTML(page, `bna-info-financiera-intento-${attempt + 1}`);
                }

                // Resto del código de extracción igual que en la función original
                const resultado = await page.evaluate(() => {
                    try {
                        // Buscar el título que contiene la fecha de vigencia
                        const tituloTasa = document.querySelector('.plazoTable h3');
                        if (!tituloTasa) {
                            return { error: 'No se encontró el título de la tasa activa' };
                        }

                        // Extraer la fecha de vigencia usando expresión regular
                        const textoTitulo = tituloTasa.textContent;
                        const regexFecha = /vigente desde el (\d{1,2}\/\d{1,2}\/\d{4})/;
                        const coincidenciaFecha = textoTitulo.match(regexFecha);

                        if (!coincidenciaFecha || !coincidenciaFecha[1]) {
                            return {
                                error: 'No se pudo extraer la fecha de vigencia',
                                textoEncontrado: textoTitulo
                            };
                        }

                        const fechaVigencia = coincidenciaFecha[1]; // Formato DD/MM/YYYY

                        // Buscar la lista que contiene las tasas
                        const listaTasas = tituloTasa.nextElementSibling;
                        if (!listaTasas || listaTasas.tagName !== 'UL') {
                            return {
                                error: 'No se encontró la lista de tasas',
                                fechaVigencia
                            };
                        }

                        // Buscar el ítem que contiene la TNA
                        const items = Array.from(listaTasas.querySelectorAll('li'));
                        const itemTNA = items.find(item =>
                            item.textContent.includes('Tasa Nominal Anual Vencida con capitalización cada 30 días')
                        );

                        if (!itemTNA) {
                            return {
                                error: 'No se encontró el ítem con la TNA',
                                fechaVigencia,
                                textoItems: items.map(item => item.textContent)
                            };
                        }

                        // Extraer el valor de la TNA usando expresión regular
                        const textoTNA = itemTNA.textContent;
                        const regexTNA = /T\.N\.A\.\s*\(\d+\s*días\)\s*=\s*(\d+[.,]\d+)%/;
                        const coincidenciaTNA = textoTNA.match(regexTNA);

                        if (!coincidenciaTNA || !coincidenciaTNA[1]) {
                            return {
                                error: 'No se pudo extraer el valor de la TNA',
                                fechaVigencia,
                                textoTNA
                            };
                        }

                        // Obtener valor numérico y normalizar
                        const valorTNA = coincidenciaTNA[1].replace(',', '.');

                        // Extraer también TEM y TEA para información completa
                        const itemTEM = items.find(item => item.textContent.includes('Tasa Efectiva Mensual Vencida'));
                        const itemTEA = items.find(item => item.textContent.includes('Tasa Efectiva Anual Vencida'));

                        let valorTEM = null;
                        let valorTEA = null;

                        if (itemTEM) {
                            const regexTEM = /T\.E\.M\.\s*\(\d+\s*días\)\s*=\s*(\d+[.,]\d+)%/;
                            const coincidenciaTEM = itemTEM.textContent.match(regexTEM);
                            if (coincidenciaTEM && coincidenciaTEM[1]) {
                                valorTEM = coincidenciaTEM[1].replace(',', '.');
                            }
                        }

                        if (itemTEA) {
                            const regexTEA = /T\.E\.A\.\s*=\s*(\d+[.,]\d+)%/;
                            const coincidenciaTEA = itemTEA.textContent.match(regexTEA);
                            if (coincidenciaTEA && coincidenciaTEA[1]) {
                                valorTEA = coincidenciaTEA[1].replace(',', '.');
                            }
                        }

                        // Retornar resultado completo
                        return {
                            fechaVigencia,
                            tna: parseFloat(valorTNA),
                            tem: valorTEM ? parseFloat(valorTEM) : null,
                            tea: valorTEA ? parseFloat(valorTEA) : null,
                            textoOriginal: {
                                titulo: textoTitulo,
                                tna: textoTNA,
                                tem: itemTEM ? itemTEM.textContent : null,
                                tea: itemTEA ? itemTEA.textContent : null
                            }
                        };
                    } catch (error) {
                        return {
                            error: `Error en la extracción: ${error.message}`
                        };
                    }
                });

                logger.info(`Resultado de la extracción (intento ${attempt + 1}):`, resultado);

                // Procesar la fecha para convertirla a formato ISO
                if (resultado.fechaVigencia) {
                    try {
                        // Convertir de formato DD/MM/YYYY a formato ISO
                        const [dia, mes, anio] = resultado.fechaVigencia.split('/');
                        const fechaISO = new Date(Date.UTC(parseInt(anio), parseInt(mes) - 1, parseInt(dia), 0, 0, 0));

                        resultado.fechaVigenciaISO = fechaISO.toISOString();
                        resultado.fechaFormateada = fechaISO.toISOString().split('T')[0];
                    } catch (error) {
                        logger.error(`Error al convertir fecha: ${error.message}`);
                        resultado.errorFecha = error.message;
                    }
                }


                // Guardar resultado en archivo JSON para referencia
                const rootDir = path.resolve(__dirname, '../../../../');
                const saveDir = path.join(rootDir, 'server', 'files');
                await fs.mkdir(saveDir, { recursive: true });
                await fs.writeFile(
                    path.join(saveDir, `tasa-activa-bna-intento-${attempt + 1}.json`),
                    JSON.stringify(resultado, null, 2)
                );

                if (resultado.error) {
                    throw resultado; // Lanzar error para que se active el mecanismo de reintento
                }

                return resultado;
            } finally {
                if (browser) {
                    try {
                        await browser.close();
                        logger.info(`Navegador cerrado (intento ${attempt + 1})`);

                    } catch (error) {
                        const browserProcess = browser.process();
                        if (browserProcess) {
                            browserProcess.kill('SIGKILL');
                        }
                    }
                }
            }
        },
        {
            maxRetries: 5,
            initialDelay: 2000,
            maxDelay: 60000,
            factor: 2,
            shouldRetry: (error) => {
                // Determinar si el error es recuperable
                const nonRetryableErrors = [
                    'No se encontró el título de la tasa activa',
                    'No se encontró la lista de tasas',
                    'No se encontró el ítem con la TNA'
                ];

                // Si es un error de estructura de la página, no reintentar
                if (error.error && nonRetryableErrors.some(msg => error.error.includes(msg))) {
                    logger.warn(`Error no recuperable, no se reintentará: ${error.error}`);
                    return false;
                }

                // Para otros errores (conexión, timeout, etc.), reintentar
                return true;
            },
            onRetry: (error, attempt) => {
                logger.warn(`Error en intento ${attempt}, reintentando extracción: ${error.message || JSON.stringify(error)}`);
            }
        }
    );
}

/**
 * Guarda una captura de pantalla con timestamp
 */
async function guardarCaptura(page, prefix) {
    try {
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        const rootDir = path.resolve(__dirname, '../../../../')
        const saveDir = path.join(rootDir, 'server', 'files');
        await fs.mkdir(saveDir, { recursive: true });

        const screenshotPath = path.join(saveDir, `${prefix}-${timestamp}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`Captura guardada: ${prefix}-${timestamp}.png`);
    } catch (error) {
        logger.error(`Error al guardar captura: ${error.message}`);
    }
}

/**
 * Guarda el HTML de la página
 */
async function guardarHTML(page, filename) {
    try {
        const html = await page.content();

        const rootDir = path.resolve(__dirname, '../../../../')
        const saveDir = path.join(rootDir, 'server', 'files');
        await fs.mkdir(saveDir, { recursive: true });

        const htmlPath = path.join(saveDir, `${filename}.html`);
        await fs.writeFile(htmlPath, html);
        logger.info(`HTML guardado en ${filename}.html`);
    } catch (error) {
        logger.error(`Error al guardar HTML: ${error.message}`);
    }
}

/**
 * Verifica y ajusta la fecha de vigencia de la tasa según la fecha actual
 * @param {Object} datosTasaActiva - Objeto con datos extraídos
 * @param {Object} configTasa - Configuración de la tasa desde TasasConfig
 * @returns {Object} - Objeto con datos ajustados y metadatos adicionales
 */
function procesarVigenciaTasa(datosTasaActiva, configTasa = null) {
    // Si no hay fecha de vigencia o hay error, devolver sin cambios
    if (!datosTasaActiva.fechaVigenciaISO || datosTasaActiva.error) {
        return datosTasaActiva;
    }

    try {
        // Obtener fecha actual en UTC (para comparar correctamente con fechaVigenciaISO)
        const fechaActual = new Date();
        const fechaActualISO = new Date(Date.UTC(
            fechaActual.getFullYear(),
            fechaActual.getMonth(),
            fechaActual.getDate()
        )).toISOString();

        // Convertir a objetos Date para comparar
        const fechaVigencia = new Date(datosTasaActiva.fechaVigenciaISO);
        const fechaHoy = new Date(fechaActualISO);

        // Variable para usar como fecha de corte para completar
        let fechaReferencia = new Date(fechaVigencia);

        // Información adicional sobre continuidad de las verificaciones
        let informacionContinuidad = null;
        if (configTasa) {
            const ultimaVerificacionDate = new Date(configTasa.fechaUltima);
            // Calcular días transcurridos desde la última verificación exitosa
            const diasDesdeUltimaVerificacion = Math.floor(
                (fechaHoy - ultimaVerificacionDate) / (1000 * 60 * 60 * 24)
            );

            // Verificar si hay continuidad en las verificaciones
            informacionContinuidad = {
                ultimaVerificacion: configTasa.fechaUltima,
                diasDesdeUltimaVerificacion,
                hayContinuidad: diasDesdeUltimaVerificacion <= 1, // Consideramos continuidad si la última verificación fue ayer o hoy
                fechasFaltantes: configTasa.fechasFaltantes || []
            };

            // Si hay un gap de más de 1 día, registrar los días faltantes
            if (diasDesdeUltimaVerificacion > 1) {
                const diasFaltantes = [];
                const fechaTmp = new Date(ultimaVerificacionDate);
                fechaTmp.setDate(fechaTmp.getDate() + 1); // Empezar desde el día siguiente a la última verificación

                // Iterar hasta el día anterior a hoy
                while (fechaTmp < fechaHoy) {
                    const fechaFaltante = new Date(fechaTmp);
                    diasFaltantes.push(fechaFaltante);
                    fechaTmp.setDate(fechaTmp.getDate() + 1);
                }

                informacionContinuidad.nuevosDiasFaltantes = diasFaltantes;
                informacionContinuidad.mensajeContinuidad = `Se detectaron ${diasFaltantes.length} día(s) sin verificación desde la última verificación (${configTasa.fechaUltima.toISOString().split('T')[0]}).`;
            } else {
                informacionContinuidad.mensajeContinuidad = 'Verificación continua sin interrupciones.';
            }
        }

        // Añadir información sobre la comparación de fechas
        const resultadoProcesado = {
            ...datosTasaActiva,
            metaVigencia: {
                fechaPublicada: datosTasaActiva.fechaVigenciaISO,
                fechaActual: fechaActualISO,
                esFechaFutura: fechaVigencia > fechaHoy,
                esFechaPasada: fechaVigencia < fechaHoy,
                esFechaActual: fechaVigencia.getTime() === fechaHoy.getTime(),
                diferenciaDias: Math.floor((fechaVigencia - fechaHoy) / (1000 * 60 * 60 * 24)),
                continuidad: informacionContinuidad
            }
        };

        // Escenario 1: Fecha de vigencia es futura - completar desde última fecha hasta fecha de vigencia
        if (resultadoProcesado.metaVigencia.esFechaFutura && configTasa) {
            const diasHastaVigencia = [];
            let ultimaFecha = new Date(configTasa.fechaUltima);

            // Si la última fecha registrada es posterior a hoy, usar la fecha de hoy
            if (ultimaFecha > fechaHoy) {
                ultimaFecha = new Date(fechaHoy);
            }
            
            const fechaSiguiente = new Date(ultimaFecha);
            fechaSiguiente.setDate(fechaSiguiente.getDate() + 1); // Empezar desde el día siguiente
            
            // Iterar hasta el día anterior a la fecha de vigencia
            while (fechaSiguiente < fechaVigencia) {
                const fechaIntermedia = new Date(fechaSiguiente);
                diasHastaVigencia.push(fechaIntermedia);
                fechaSiguiente.setDate(fechaSiguiente.getDate() + 1);
            }
            
            // Si hay días intermedios, añadirlos a la respuesta para su procesamiento
            if (diasHastaVigencia.length > 0) {
                resultadoProcesado.metaVigencia.diasHastaVigencia = diasHastaVigencia;
                resultadoProcesado.metaVigencia.requiereCompletarIntermedio = true;
                
                logger.info(`Se necesita completar ${diasHastaVigencia.length} día(s) con el valor actual hasta la nueva fecha de vigencia: ${fechaVigencia.toISOString().split('T')[0]}`);
            }
        }
        // Escenario 2: Fecha de vigencia es pasada - completar desde fecha de vigencia hasta fecha actual
        else if (resultadoProcesado.metaVigencia.esFechaPasada) {
            const diasHastaHoy = [];
            
            // Comenzar desde el día siguiente a la fecha de vigencia
            const fechaSiguiente = new Date(fechaVigencia);
            fechaSiguiente.setDate(fechaSiguiente.getDate() + 1);
            
            // Iterar hasta el día de hoy inclusive
            while (fechaSiguiente <= fechaHoy) {
                const fechaIntermedia = new Date(fechaSiguiente);
                diasHastaHoy.push(fechaIntermedia);
                fechaSiguiente.setDate(fechaSiguiente.getDate() + 1);
            }
            
            // Si hay días para completar entre la fecha de vigencia y hoy
            if (diasHastaHoy.length > 0) {
                resultadoProcesado.metaVigencia.diasDesdeVigencia = diasHastaHoy;
                resultadoProcesado.metaVigencia.requiereCompletarDesdeVigencia = true;
                resultadoProcesado.metaVigencia.fechaReferenciaPublicacion = fechaVigencia;
                
                logger.info(`Se encontró una fecha de vigencia pasada (${datosTasaActiva.fechaFormateada}). Se completarán ${diasHastaHoy.length} día(s) hasta hoy (${fechaHoy.toISOString().split('T')[0]}) con el valor de esta publicación.`);
            }
        }

        // Añadir mensaje informativo según la comparación
        if (resultadoProcesado.metaVigencia.esFechaFutura) {
            resultadoProcesado.metaVigencia.mensaje = 
                `La fecha de vigencia publicada (${datosTasaActiva.fechaFormateada}) es ${Math.abs(resultadoProcesado.metaVigencia.diferenciaDias)} día(s) en el futuro respecto a la fecha actual (${fechaActualISO.split('T')[0]}). Esta tasa se aplicará para cálculos a partir de la fecha de vigencia.`;
        } else if (resultadoProcesado.metaVigencia.esFechaPasada) {
            resultadoProcesado.metaVigencia.mensaje = 
                `La fecha de vigencia publicada (${datosTasaActiva.fechaFormateada}) es ${Math.abs(resultadoProcesado.metaVigencia.diferenciaDias)} día(s) en el pasado respecto a la fecha actual (${fechaActualISO.split('T')[0]}). Esta tasa se aplica para cálculos con la fecha actual.`;
        } else {
            resultadoProcesado.metaVigencia.mensaje = 
                `La fecha de vigencia publicada (${datosTasaActiva.fechaFormateada}) coincide con la fecha actual.`;
        }

        logger.info(`Análisis de vigencia de tasa: ${resultadoProcesado.metaVigencia.mensaje}`);
        
        // Registrar información de continuidad si existe
        if (informacionContinuidad) {
            logger.info(`Continuidad de verificaciones: ${informacionContinuidad.mensajeContinuidad}`);
        }
        
        // Añadir registro de esta publicación para llevar el control
        resultadoProcesado.metaPublicacion = {
            fechaPublicacion: new Date().toISOString(),
            fechaVigencia: fechaVigencia.toISOString(),
            origen: 'bnaService',
            valores: {
                tna: datosTasaActiva.tna,
                tem: datosTasaActiva.tem,
                tea: datosTasaActiva.tea
            }
        };
        
        return resultadoProcesado;

    } catch (error) {
        logger.error(`Error al procesar vigencia de tasa: ${error.message}`);
        return {
            ...datosTasaActiva,
            errorProcesamiento: `Error al procesar vigencia: ${error.message}`
        };
    }
}

/**
 * Función para actualizar el registro de fechas en TasasConfig
 * @param {String} tipoTasa - Tipo de tasa a actualizar
 * @param {Object} datosVigencia - Datos de vigencia con información de continuidad
 * @returns {Promise<Object>} - Configuración actualizada
 */
async function actualizarRegistroFechas(tipoTasa, datosVigencia) {
    try {
        // Obtener la configuración de la tasa
        const configTasa = await TasasConfig.findOne({ tipoTasa });
        if (!configTasa) {
            logger.warn(`No se encontró configuración para la tasa ${tipoTasa}`);
            return null;
        }
        
        // Obtener fecha actual en UTC
        const fechaHoy = new Date();
        fechaHoy.setUTCHours(0, 0, 0, 0);
        
        // Actualizar fecha última
        configTasa.fechaUltima = fechaHoy;
        configTasa.ultimaVerificacion = new Date(); // Timestamp actual
        
        // Si hay información de continuidad y días faltantes, agregarlos al registro
        if (datosVigencia && 
            datosVigencia.metaVigencia && 
            datosVigencia.metaVigencia.continuidad && 
            datosVigencia.metaVigencia.continuidad.nuevosDiasFaltantes && 
            datosVigencia.metaVigencia.continuidad.nuevosDiasFaltantes.length > 0) {
            
            // Agregar nuevos días faltantes al registro
            const nuevosDias = datosVigencia.metaVigencia.continuidad.nuevosDiasFaltantes;
            
            // Si no existe el array, inicializarlo
            if (!configTasa.fechasFaltantes) {
                configTasa.fechasFaltantes = [];
            }
            
            // Agregar los nuevos días faltantes (evitando duplicados)
            for (const nuevoDia of nuevosDias) {
                const fechaNueva = new Date(nuevoDia);
                fechaNueva.setUTCHours(0, 0, 0, 0);
                
                // Verificar si ya existe esta fecha en el array
                const existeFecha = configTasa.fechasFaltantes.some(fecha => 
                    fecha.getTime() === fechaNueva.getTime()
                );
                
                if (!existeFecha) {
                    configTasa.fechasFaltantes.push(fechaNueva);
                    logger.info(`Agregada fecha faltante: ${fechaNueva.toISOString().split('T')[0]} para ${tipoTasa}`);
                }
            }
        }
        
        // Guardar los cambios
        await configTasa.save();
        logger.info(`Registro de fechas actualizado para ${tipoTasa}`);
        return configTasa;
        
    } catch (error) {
        logger.error(`Error al actualizar registro de fechas: ${error.message}`);
        return null;
    }
}

/**
 * Función auxiliar para completar días intermedios con el valor de la tasa anterior
 * @param {String} tipoTasa - Tipo de tasa a actualizar
 * @param {Array} diasIntermedios - Array de fechas intermedias a completar
 * @param {Object} datosUltimoRegistro - Datos del último registro en la BD
 * @returns {Promise<Object>} - Resultado de la operación
 */
async function completarDiasIntermedios(tipoTasa, diasIntermedios, datosUltimoRegistro) {
    try {
        if (!diasIntermedios || diasIntermedios.length === 0) {
            return {
                status: 'success',
                message: 'No hay días intermedios para completar',
                completos: 0
            };
        }

        const { actualizarFechasFaltantes } = require('../../../controllers/tasasConfigController');
        logger.info(`Completando ${diasIntermedios.length} días intermedios para ${tipoTasa} hasta nueva fecha de vigencia`);
        
        // Preparar los datos para guardar en cada día intermedio
        const resultadosIntermedio = [];
        const fechasActualizadas = [];
        
        for (const fecha of diasIntermedios) {
            // Para cada tipo de tasa, creamos los datos correctos para esa tasa específica
            // basados en los valores del último registro, NUNCA de la nueva publicación
            let valorTasa;
            
            // Si tenemos los valores originales, usarlos directamente
            if (datosUltimoRegistro.valorOriginal && datosUltimoRegistro.valorOriginal[tipoTasa] !== undefined) {
                valorTasa = datosUltimoRegistro.valorOriginal[tipoTasa];
                logger.info(`Usando valor original para ${tipoTasa}: ${valorTasa}`);
            } 
            // Si no tenemos el valor original, lo buscamos en el objeto principal
            else if (datosUltimoRegistro[tipoTasa] !== undefined) {
                valorTasa = datosUltimoRegistro[tipoTasa];
                logger.info(`Usando valor del objeto para ${tipoTasa}: ${valorTasa}`);
            }
            // Si no encontramos el valor, usamos la fórmula para calcularlo según el tipo de tasa
            else {
                switch(tipoTasa) {
                    case 'tasaActivaBNA':
                        // tasaActivaBNA es tem/30
                        valorTasa = datosUltimoRegistro.tem ? datosUltimoRegistro.tem / 30 : null;
                        break;
                    case 'tasaActivaTnaBNA':
                        // tasaActivaTnaBNA es tna/365
                        valorTasa = datosUltimoRegistro.tna ? datosUltimoRegistro.tna / 365 : null;
                        break;
                    case 'tasaActivaCNAT2658':
                    case 'tasaActivaCNAT2764':
                        // Ambas son tea/365
                        valorTasa = datosUltimoRegistro.tea ? datosUltimoRegistro.tea / 365 : null;
                        break;
                    default:
                        valorTasa = null;
                }
                
                if (valorTasa !== null) {
                    logger.info(`Valor calculado para ${tipoTasa}: ${valorTasa}`);
                } else {
                    logger.warn(`No se pudo determinar valor para ${tipoTasa}`);
                    continue; // Saltar esta fecha si no podemos calcular el valor
                }
            }
            
            // Crear un objeto específico para la tasa que estamos completando
            // con los valores calculados correctamente
            const datosEspecificos = {
                status: 'success',
                data: {
                    fechaVigenciaISO: fecha.toISOString(),
                    fechaFormateada: fecha.toISOString().split('T')[0],
                    tna: datosUltimoRegistro.tna,
                    tem: datosUltimoRegistro.tem,
                    tea: datosUltimoRegistro.tea,
                    [tipoTasa]: valorTasa, // Usar el valor correcto para esta tasa específica
                    origenDato: 'completado_automaticamente',
                    fechaOriginalRegistro: datosUltimoRegistro.fechaFormateada,
                    metaInfo: {
                        descripcion: `Valor completado automáticamente usando datos de la última publicación del ${datosUltimoRegistro.fechaFormateada}`,
                        fechaCompletado: new Date().toISOString(),
                        tasaReferencia: tipoTasa,
                        fuenteCompletado: 'bnaService_corregido'
                    }
                }
            };
            
            // Crear una función específica para cada tipo de tasa
            // Esta es una forma directa de guardar los datos sin pasar por las conversiones normales
            let guardarFuncion;
            
            if (tipoTasa === 'tasaActivaBNA') {
                guardarFuncion = getTasasController().guardarTasaActivaBNA;
            } else {
                // Para otras tasas, crear un wrapper específico
                guardarFuncion = async (datos) => {
                    // Simular el mismo formato que guardarTasaActivaBNA
                    return await getTasasController().actualizarTasa(
                        datos,
                        tipoTasa,
                        () => valorTasa, // Usar directamente el valor calculado
                        [], // Sin tasas adicionales
                        'BNA Web'
                    );
                };
            }
            
            // Guardar en la base de datos este día intermedio usando la función apropiada
            const resultado = await guardarFuncion(datosEspecificos);
            
            // Si se guardó correctamente, añadir a lista de fechas procesadas para actualizar TasasConfig
            if (resultado && resultado.actualizado) {
                fechasActualizadas.push({
                    fecha: fecha.toISOString().split('T')[0],
                    values: { [tipoTasa]: valorTasa },
                    origen: 'completado_automatico'
                });
                
                resultadosIntermedio.push({
                    fecha: fecha.toISOString().split('T')[0],
                    resultado: 'completado',
                    mensaje: resultado.mensaje,
                    valor: valorTasa
                });
                
                logger.info(`Día intermedio ${fecha.toISOString().split('T')[0]} para ${tipoTasa}: Completado con valor ${valorTasa}`);
            } else {
                resultadosIntermedio.push({
                    fecha: fecha.toISOString().split('T')[0],
                    resultado: 'error',
                    mensaje: resultado ? resultado.mensaje : 'Error desconocido'
                });
                
                logger.warn(`Día intermedio ${fecha.toISOString().split('T')[0]} para ${tipoTasa}: No actualizado`);
            }
        }
        
        // Si se actualizaron fechas, actualizar la lista de fechasFaltantes en TasasConfig
        if (fechasActualizadas.length > 0) {
            try {
                // Ejecutar actualizarFechasFaltantes para eliminar estas fechas de fechasFaltantes
                const resultadoActualizacion = await actualizarFechasFaltantes(tipoTasa, fechasActualizadas);
                logger.info(`Actualización de fechasFaltantes para ${tipoTasa}: ${resultadoActualizacion.message}`);
            } catch (errorActualizar) {
                logger.error(`Error al actualizar fechasFaltantes: ${errorActualizar.message}`);
            }
        }
        
        // Retornar resultado consolidado
        const diasCompletados = resultadosIntermedio.filter(r => r.resultado === 'completado').length;
        
        return {
            status: 'success',
            message: `Se completaron ${diasCompletados} de ${diasIntermedios.length} días intermedios para ${tipoTasa}`,
            completos: diasCompletados,
            detalles: resultadosIntermedio,
            fechasActualizadas
        };
    } catch (error) {
        logger.error(`Error al completar días intermedios para ${tipoTasa}: ${error.message}`);
        return {
            status: 'error',
            message: `Error al completar días intermedios para ${tipoTasa}: ${error.message}`,
            completos: 0
        };
    }
}

/**
 * Función principal mejorada con reintentos y manejo de fechas
 * @param {String} tipoTasaParam - Tipo de tasa a actualizar (opcional, por defecto 'tasaActivaBNA')
 * @param {String} taskIdParam - ID de la tarea (opcional, se genera automáticamente si no se proporciona)
 * @returns {Promise<Object>} - Resultado de la actualización
 */
async function actualizarTasaActivaBNAConReintentos(tipoTasaParam, taskIdParam) {
    const tipoTasa = tipoTasaParam || 'tasaActivaBNA';
    const taskId = taskIdParam || `bna-tasa-activa-${tipoTasa.toLowerCase()}`;
    
    try {
        logger.info(`Iniciando actualización de ${tipoTasa} con reintentos`);

        // Obtener configuración actual de la tasa
        const configTasa = await TasasConfig.findOne({ tipoTasa });
        if (!configTasa) {
            logger.warn(`No se encontró configuración para ${tipoTasa}, se continuará sin verificar continuidad`);
        }

        // Extraer datos de la página web con reintentos
        const datosTasaActiva = await extraerTasaActivaBNAConReintentos();

        if (datosTasaActiva.error) {
            const errorMsg = `Error en la extracción: ${datosTasaActiva.error}`;
            // Registrar error en TasasConfig
            await registrarErrorTasa(
                tipoTasa,
                taskId,
                errorMsg,
                JSON.stringify(datosTasaActiva),
                'EXTRACTION_ERROR'
            );
            throw new Error(errorMsg);
        }

        if (!datosTasaActiva.tna || !datosTasaActiva.fechaVigenciaISO) {
            const errorMsg = 'No se pudo extraer la tasa o la fecha de vigencia';
            // Registrar error en TasasConfig
            await registrarErrorTasa(
                tipoTasa,
                taskId,
                errorMsg,
                JSON.stringify(datosTasaActiva),
                'MISSING_DATA'
            );
            throw new Error(errorMsg);
        }
        
        // Verificar si la fecha de vigencia ya está actualizada y no hay fechas faltantes
        if (configTasa) {
            const fechaVigencia = new Date(datosTasaActiva.fechaVigenciaISO);
            const fechaUltima = new Date(configTasa.fechaUltima);
            
            // Normalizar fechas a UTC 00:00:00 para comparación
            fechaVigencia.setUTCHours(0, 0, 0, 0);
            fechaUltima.setUTCHours(0, 0, 0, 0);
            
            // Si la fecha de vigencia coincide con la fecha última en TasasConfig
            // y no hay fechas faltantes, no hay nada que actualizar
            if (fechaVigencia.getTime() === fechaUltima.getTime() && 
                (!configTasa.fechasFaltantes || configTasa.fechasFaltantes.length === 0)) {
                
                logger.info(`La fecha de vigencia publicada (${datosTasaActiva.fechaFormateada}) ya está actualizada en la base de datos`);
                logger.info(`No hay fechas faltantes registradas. No se requiere actualización.`);
                
                // Resolver cualquier error previo para este tipo de tasa y tarea
                if (configTasa) {
                    await configTasa.resolverErrores(taskId);
                }
                
                return {
                    status: 'success',
                    message: `No se requiere actualización. La fecha ${datosTasaActiva.fechaFormateada} ya está actualizada y no hay fechas faltantes.`,
                    data: datosTasaActiva,
                    actualizado: false,
                    motivo: 'fecha_ya_actualizada'
                };
            }
        }

        // Procesar vigencia de la tasa comparando con fecha actual y verificando continuidad
        const datosConVigencia = procesarVigenciaTasa(datosTasaActiva, configTasa);

        // Actualizar registro de fechas en TasasConfig
        const configActualizada = await actualizarRegistroFechas(tipoTasa, datosConVigencia);

        // Variable para almacenar resultados de completar días intermedios
        let resultadoCompletado = null;

        // Si hay fechas intermedias hasta la vigencia, completarlas con el valor del último registro
        if (datosConVigencia.metaVigencia && 
            datosConVigencia.metaVigencia.requiereCompletarIntermedio && 
            datosConVigencia.metaVigencia.diasHastaVigencia && 
            datosConVigencia.metaVigencia.diasHastaVigencia.length > 0) {
            
            logger.info(`Se detectó una fecha de vigencia futura (${datosConVigencia.fechaFormateada}). Buscando último registro para completar fechas intermedias.`);
            
            // Buscar el último valor registrado para obtener los datos a propagar
            const fechaHoy = new Date();
            fechaHoy.setUTCHours(0, 0, 0, 0);
            
            // IMPORTANTE: Buscamos el último registro ANTERIOR a la fecha de hoy, no el actual
            const ultimoRegistro = await Tasas.findOne({ 
                fecha: { $lt: fechaHoy },
                [tipoTasa]: { $exists: true, $ne: null } 
            }).sort({ fecha: -1 });
            
            if (ultimoRegistro && ultimoRegistro[tipoTasa]) {
                logger.info(`Encontrado último registro para ${tipoTasa} del ${moment(ultimoRegistro.fecha).format('YYYY-MM-DD')} con valor: ${ultimoRegistro[tipoTasa]}`);
                
                // Obtener los datos de ese último registro para tasas adicionales también
                const tasasAdicionales = ['tasaActivaTnaBNA', 'tasaActivaCNAT2658', 'tasaActivaCNAT2764'];
                const valoresAdicionales = {};
                
                // Registrar valores de todas las tasas relacionadas
                for (const tasaAdicional of tasasAdicionales) {
                    if (ultimoRegistro[tasaAdicional] !== undefined) {
                        valoresAdicionales[tasaAdicional] = ultimoRegistro[tasaAdicional];
                        logger.info(`  - Valor de ${tasaAdicional}: ${ultimoRegistro[tasaAdicional]}`);
                    }
                }
                
                // Calcular valores de las tasas para las fechas intermedias (basado en el último registro, NO en la nueva publicación)
                // Necesitamos recalcular los valores para que coincidan con los cálculos originales
                
                // Para tasaActivaBNA, necesitamos reconstruir el valor de TEM (ya que normalmente TEM/30 es lo que se guarda)
                // y para los demás necesitamos reconstruir TEA (ya que TEA/365 es lo que se guarda)
                const temReconstruido = ultimoRegistro[tipoTasa] * 30;  // Invertir la fórmula tem/30
                const teaReconstruida = ultimoRegistro.tasaActivaCNAT2658 * 365; // Invertir la fórmula tea/365
                
                // Crear objeto con datos basados en el último registro (NO del actual)
                const ultimoDatoScraping = {
                    // Valores reconstruidos para los cálculos
                    tna: ultimoRegistro.tasaActivaTnaBNA * 365, // Reconstruir TNA
                    tem: temReconstruido,                       // Reconstruir TEM
                    tea: teaReconstruida,                       // Reconstruir TEA
                    // Metadatos
                    fechaFormateada: moment(ultimoRegistro.fecha).format('YYYY-MM-DD'),
                    fechaVigenciaISO: ultimoRegistro.fecha.toISOString(),
                    valorOriginal: {
                        tasaActivaBNA: ultimoRegistro.tasaActivaBNA,
                        tasaActivaTnaBNA: ultimoRegistro.tasaActivaTnaBNA,
                        tasaActivaCNAT2658: ultimoRegistro.tasaActivaCNAT2658,
                        tasaActivaCNAT2764: ultimoRegistro.tasaActivaCNAT2764
                    },
                    fuenteDatos: 'registro_previo_BNA',
                    origenCompletado: 'completado_desde_ultimo_registro'
                };
                
                // Completar los días intermedios con el valor del último registro
                resultadoCompletado = await completarDiasIntermedios(
                    tipoTasa, 
                    datosConVigencia.metaVigencia.diasHastaVigencia,
                    ultimoDatoScraping
                );
                
                logger.info(`Completado de días intermedios: ${resultadoCompletado.message}`);
                
                // Completar también las tasas adicionales si existen
                for (const tasaAdicional of tasasAdicionales) {
                    if (valoresAdicionales[tasaAdicional] !== undefined) {
                        logger.info(`Completando días intermedios para tasa adicional: ${tasaAdicional}`);
                        
                        const resultadoAdicional = await completarDiasIntermedios(
                            tasaAdicional,
                            datosConVigencia.metaVigencia.diasHastaVigencia,
                            ultimoDatoScraping
                        );
                        
                        logger.info(`Completado para ${tasaAdicional}: ${resultadoAdicional.message}`);
                    }
                }
            } else {
                logger.warn(`No se encontró registro previo para completar días intermedios para ${tipoTasa}`);
            }
        }
        // Escenario 2: Si es una fecha de vigencia pasada, completar desde esa fecha hasta hoy
        else if (datosConVigencia.metaVigencia && 
                 datosConVigencia.metaVigencia.requiereCompletarDesdeVigencia && 
                 datosConVigencia.metaVigencia.diasDesdeVigencia && 
                 datosConVigencia.metaVigencia.diasDesdeVigencia.length > 0) {
            
            logger.info(`Se detectó una fecha de vigencia pasada (${datosConVigencia.fechaFormateada}). Completando fechas desde esta publicación hasta el día de hoy.`);
            
            // Para una fecha de vigencia pasada, usamos los valores de la publicación actual
            // para completar todas las fechas desde esa publicación hasta hoy
            
            // Crear objeto con datos basados en la publicación actual
            const datosPublicacionActual = {
                // Valores de la publicación actual
                tna: datosConVigencia.tna,
                tem: datosConVigencia.tem,
                tea: datosConVigencia.tea,
                // Metadatos
                fechaFormateada: datosConVigencia.fechaFormateada,
                fechaVigenciaISO: datosConVigencia.fechaVigenciaISO,
                valorOriginal: {
                    tasaActivaBNA: datosConVigencia.tem / 30, // Calcular según la fórmula
                    tasaActivaTnaBNA: datosConVigencia.tna / 365,
                    tasaActivaCNAT2658: datosConVigencia.tea / 365,
                    tasaActivaCNAT2764: datosConVigencia.tea / 365
                },
                fuenteDatos: 'publicacion_pasada_BNA',
                origenCompletado: 'completado_desde_publicacion_pasada'
            };
            
            // Completar los días desde la fecha de vigencia hasta hoy con el valor de la publicación
            resultadoCompletado = await completarDiasIntermedios(
                tipoTasa, 
                datosConVigencia.metaVigencia.diasDesdeVigencia,
                datosPublicacionActual
            );
            
            logger.info(`Completado de días desde fecha de vigencia pasada hasta hoy: ${resultadoCompletado.message}`);
            
            // Completar también las tasas adicionales
            const tasasAdicionales = ['tasaActivaTnaBNA', 'tasaActivaCNAT2658', 'tasaActivaCNAT2764'];
            for (const tasaAdicional of tasasAdicionales) {
                logger.info(`Completando días desde fecha de vigencia pasada para tasa adicional: ${tasaAdicional}`);
                
                const resultadoAdicional = await completarDiasIntermedios(
                    tasaAdicional,
                    datosConVigencia.metaVigencia.diasDesdeVigencia,
                    datosPublicacionActual
                );
                
                logger.info(`Completado para ${tasaAdicional}: ${resultadoAdicional.message}`);
            }
        }

        // Determinar el tipo de completado para incluir en la respuesta
        let tipoCompletado = null;
        if (datosConVigencia.metaVigencia && datosConVigencia.metaVigencia.requiereCompletarIntermedio) {
            tipoCompletado = 'completadoIntermedio';
        } else if (datosConVigencia.metaVigencia && datosConVigencia.metaVigencia.requiereCompletarDesdeVigencia) {
            tipoCompletado = 'completadoDesdeVigencia';
        }

        // Preparar objeto de respuesta con información de continuidad
        const resultadoScraping = {
            status: 'success',
            message: `${tipoTasa} actualizada correctamente`,
            data: datosConVigencia,
            completadoTipo: tipoCompletado,
            completadoResultado: resultadoCompletado,
            continuidad: configActualizada ? {
                fechaUltima: configActualizada.fechaUltima,
                fechasFaltantes: configActualizada.fechasFaltantes.length > 0 ? 
                    configActualizada.fechasFaltantes.map(f => f.toISOString().split('T')[0]) : []
            } : null
        };

        // Guardar en la base de datos
        const resultadoGuardado = await getTasasController().guardarTasaActivaBNA(resultadoScraping);

        logger.info(`${tipoTasa} extraída: ${datosConVigencia.tna}% (vigente desde ${datosConVigencia.fechaFormateada})`);
        if (datosConVigencia.metaVigencia) {
            logger.info(`Estado de vigencia: ${datosConVigencia.metaVigencia.mensaje}`);
        }

        if (resultadoGuardado.actualizado) {
            logger.info(`${tipoTasa} guardada en BD correctamente con valor: ${resultadoGuardado.valor}`);
            
            // Resolver cualquier error previo para este tipo de tasa y tarea
            if (configTasa) {
                await configTasa.resolverErrores(taskId);
            }
        } else {
            logger.warn(`No se guardó la tasa en la BD: ${resultadoGuardado.mensaje}`);
            
            // No registramos como error cuando no hay cambios en la tasa,
            // solo si hay un error de persistencia real
            if (resultadoGuardado.status === 'error') {
                await registrarErrorTasa(
                    tipoTasa,
                    taskId,
                    `Error al guardar tasa: ${resultadoGuardado.mensaje}`,
                    JSON.stringify(resultadoGuardado),
                    'SAVE_ERROR'
                );
            }
        }

        return {
            status: 'success',
            message: `${tipoTasa} actualizada correctamente`,
            data: datosConVigencia,
            resultadoGuardado,
            completadoTipo: resultadoScraping.completadoTipo,
            completadoResultado: resultadoScraping.completadoResultado,
            continuidad: resultadoScraping.continuidad
        };

    } catch (error) {
        logger.error(`Error en actualizarTasaActivaBNAConReintentos para ${tipoTasa}: ${error.message}`);
        
        // Registrar error general si no se ha registrado un error específico previamente
        if (!error.message.includes('Error en la extracción') && 
            !error.message.includes('No se pudo extraer la tasa')) {
            await registrarErrorTasa(
                tipoTasa,
                taskId,
                `Error general en actualización de ${tipoTasa}: ${error.message}`,
                error.stack || '',
                'GENERAL_ERROR'
            );
        }
        
        return {
            status: 'error',
            message: error.message,
            tipoTasa
        };
    }
}

/**
 * Actualiza la tasa para un tipo específico o usando el tipo por defecto 'tasaActivaBNA'
 * @param {String} tipoTasa - Tipo de tasa a actualizar (opcional)
 * @returns {Promise<Object>} - Resultado de la actualización
 */
async function actualizarTasaEspecifica(tipoTasa) {
    const tipoTasaActual = tipoTasa || 'tasaActivaBNA';
    
    // Validar que sea un tipo de tasa compatible
    const tiposCompatibles = ['tasaActivaBNA', 'tasaActivaTnaBNA', 'tasaActivaCNAT2658', 'tasaActivaCNAT2764'];
    if (!tiposCompatibles.includes(tipoTasaActual)) {
        logger.warn(`Tipo de tasa no estándar: ${tipoTasaActual}. Se usará para operaciones pero podría no ser compatible.`);
    }
    
    // Generar taskId específico para el tipo de tasa
    const taskId = `bna-tasa-activa-${tipoTasaActual.toLowerCase()}`;
    
    // Llamar a la función principal con el tipo de tasa específico
    return actualizarTasaActivaBNAConReintentos(tipoTasaActual, taskId);
}

// Exportar actualizarTasa como parte del módulo para uso interno
exports.actualizarTasa = actualizarTasa;

module.exports = {
    extraerTasaActivaBNAConReintentos,
    actualizarTasaActivaBNAConReintentos,
    procesarVigenciaTasa,
    actualizarRegistroFechas,
    actualizarTasaEspecifica,
    completarDiasIntermedios
};