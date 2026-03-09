const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const moment = require('moment');
const logger = require('../../../utils/logger');
const TasasConfig = require('../../../models/tasasConfig');
const { parseFechaISO, obtenerDiaSiguiente, obtenerFechaActualISO } = require('../../../utils/format');
const { getUltimaTasaHastaFecha, bulkUpsertTasas, obtenerRangoFechasFaltantes, procesarActualizacionTasas, verificarFechasFaltantes } = require('../../../controllers/tasasController');
const { getPuppeteerConfig } = require('../../../config/puppeteer');
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
 * Convierte una fecha en formato DD/MM/YYYY a un objeto Date
 * @param {string} fechaStr - Fecha en formato DD/MM/YYYY
 * @returns {Date} - Objeto Date
 */
function convertirStringADate(fechaStr) {
    if (!fechaStr) return { fechaDate: null, fechaISO: null };

    try {
        // Convertir formato DD/MM/YYYY a Date
        const partes = fechaStr.split('/');
        if (partes.length !== 3) return { fechaDate: null, fechaISO: null };

        const dia = parseInt(partes[0], 10);
        const mes = parseInt(partes[1], 10) - 1; // Los meses en Date van de 0-11
        const anio = parseInt(partes[2], 10);

        // Crear objeto Date con la fecha a las 00:00:00 en UTC
        const fechaDate = new Date(Date.UTC(anio, mes, dia, 0, 0, 0, 0));

        // Formatear fecha como ISO string con UTC explícito (+00:00 en lugar de Z)
        const fechaISO = fechaDate.toISOString().replace('Z', '+00:00');

        return { fechaDate, fechaISO };
    } catch (error) {
        logger.error(`Error al convertir fecha ${fechaStr}: ${error.message}`);
        return { fechaDate: null, fechaISO: null };
    }
}

/**
 * Adapta los resultados del scraping al formato del modelo MongoDB
 * @param {Object} resultados - Resultados obtenidos del scraping
 * @returns {Array} - Array de objetos listos para insertar en MongoDB
 */
function adaptarResultadosAModelo(resultados, usarFechaISO = true) {
    if (!resultados || !resultados.datos || !Array.isArray(resultados.datos)) {
        logger.error('No hay datos válidos para adaptar al modelo');
        return [];
    }

    // Convertir cada fila de datos al formato del modelo
    const tasasFormateadas = resultados.datos.map(dato => {
        try {
            // Transformar fechas a objetos Date
            const fechaInicio = convertirStringADate(dato.fechaInicio);
            const fechaFin = convertirStringADate(dato.fechaFin);

            // La tasa ya está como número (campo tasa)
            const interesMensual = dato.tasa;

            // Crear objeto según el modelo
            return {
                fechaInicio: usarFechaISO ? fechaInicio.fechaISO : fechaInicio.fechaDate,
                fechaFin: usarFechaISO ? fechaFin.fechaISO : fechaFin.fechaDate,
                interesMensual
            };
        } catch (error) {
            logger.error(`Error al adaptar dato: ${error.message}`);
            return null;
        }
    }).filter(item => item !== null); // Eliminar elementos nulos (si hubo errores)

    logger.info(`Se adaptaron ${tasasFormateadas.length} registros al modelo MongoDB`);
    return tasasFormateadas;
}

/**
 * Extrae los resultados y los adapta al formato del modelo MongoDB
 * @param {Page} page - Instancia de página de Puppeteer
 * @param {boolean} screenshot - Indica si se deben tomar capturas de pantalla
 * @returns {Object} - Resultados del cálculo en formato estructurado
 */
async function extraerResultadosParaMongo(page, screenshot = true) {
    try {
        // Primero extraer los resultados normales
        const resultadosOriginales = await extraerResultados(page, screenshot);

        // Si hubo un error en la extracción original, devolverlo
        if (resultadosOriginales.error) {
            return resultadosOriginales;
        }

        // Adaptar los resultados al formato del modelo
        const tasasFormateadas = adaptarResultadosAModelo(resultadosOriginales);

        // Guardar los resultados formateados para MongoDB en un archivo JSON
        try {
            const jsonPath = path.join(process.cwd(), 'server', 'files', 'tasas-para-mongo.json');
            await fs.writeFile(jsonPath, JSON.stringify(tasasFormateadas, null, 2));
            logger.info('Resultados adaptados guardados en server/files/tasas-para-mongo.json');
        } catch (writeError) {
            logger.error(`Error al guardar JSON adaptado: ${writeError.message}`);
        }

        // Devolver tanto los resultados originales como los formateados
        return {
            resultadosOriginales,
            tasasParaMongo: tasasFormateadas
        };
    } catch (error) {
        logger.error(`Error al adaptar resultados para MongoDB: ${error.message}`);
        return { error: error.message };
    }
}

/**
 * Guarda una captura de pantalla con timestamp
 */
async function guardarCaptura(page, prefix) {
    try {
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        const screenshotPath = path.join(process.cwd(), 'server', 'files', `${prefix}-${timestamp}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`Captura guardada en server/files: ${prefix}-${timestamp}.png`);
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
        const htmlPath = path.join(process.cwd(), 'server', 'files', `${filename}.html`);
        await fs.writeFile(htmlPath, html);
        logger.info(`HTML guardado en server/files: ${filename}.html`);
    } catch (error) {
        logger.error(`Error al guardar HTML: ${error.message}`);
    }
}

/**
 * Ingresa el monto en el formulario
 * @param {Page} page - Instancia de página de Puppeteer
 * @param {number} monto - Monto a ingresar
 * @returns {boolean} - true si se ingresó correctamente
 */
async function ingresarMonto(page, monto, screenshot) {
    try {
        logger.info(`Ingresando monto: ${monto}`);

        const montoIngresado = await page.evaluate((valor) => {
            // Buscar el input de monto
            const inputMonto = document.querySelector('input[type="number"]');

            if (inputMonto) {
                // Limpiar el campo primero
                inputMonto.value = '';
                // Ingresar el nuevo valor
                inputMonto.value = valor;
                // Disparar eventos para activar validaciones
                inputMonto.dispatchEvent(new Event('input', { bubbles: true }));
                inputMonto.dispatchEvent(new Event('change', { bubbles: true }));
                return `Monto ingresado: ${valor}`;
            }

            return 'No se encontró el campo de monto';
        }, monto.toString());

        logger.info(montoIngresado);
        await page.waitForTimeout(1000);

        screenshot ?
            await guardarCaptura(page, 'despues-ingresar-monto') : false;

        return montoIngresado.includes(`Monto ingresado: ${monto}`);
    } catch (error) {
        logger.error(`Error al ingresar monto: ${error.message}`);
        return false;
    }
}

/**
 * Selecciona un día del selector desplegable
 * @param {Page} page - Instancia de página de Puppeteer
 * @param {string} diaDeseado - Día a seleccionar (ej: "01", "15", "31")
 * @param {boolean} esFechaHasta - Indica si es para la fecha hasta (segundo selector)
 * @returns {boolean} - true si se seleccionó correctamente
 */
async function seleccionarDia(page, diaDeseado, esFechaHasta = false, screenshot) {
    try {
        // Normalizar el día (asegurarse de que tenga dos dígitos)
        diaDeseado = diaDeseado.toString().padStart(2, '0');
        logger.info(`Intentando seleccionar el día: ${diaDeseado} para fecha ${esFechaHasta ? 'hasta' : 'desde'}`);

        // 1. Hacer clic en el selector de día para abrir el menú desplegable
        const diaSelector = await page.evaluate((esFechaHasta) => {
            // Buscar todos los botones combobox
            const todosLosBotones = Array.from(document.querySelectorAll('button[role="combobox"]'));

            // Filtrar los botones que contienen valores numéricos (posibles días)
            const botonesDia = todosLosBotones.filter(btn => {
                const span = btn.querySelector('span');
                return span && /^\d{1,2}$/.test(span.textContent.trim());
            });

            // Si hay al menos dos conjuntos de selectores (uno para fecha desde y otro para fecha hasta)
            if (botonesDia.length >= 2 && esFechaHasta) {
                // Para fecha hasta, usar el segundo conjunto de selectores
                botonesDia[1].click();
                return `Selector de día para fecha hasta clickeado: ${botonesDia[1].textContent.trim()}`;
            } else if (botonesDia.length > 0) {
                // Para fecha desde, usar el primer conjunto
                botonesDia[0].click();
                return `Selector de día para fecha desde clickeado: ${botonesDia[0].textContent.trim()}`;
            }

            return null;
        }, esFechaHasta);

        logger.info(diaSelector || 'No se pudo encontrar o hacer clic en el selector de día');

        if (!diaSelector) {
            // Intento alternativo: buscar por atributos específicos
            const selector = esFechaHasta
                ? 'div.mb-10:nth-child(3) button[data-select-trigger], div:contains("Fecha hasta") ~ div button[data-select-trigger]'
                : 'div.mb-10:nth-child(2) button[data-select-trigger], div:contains("Fecha desde") ~ div button[data-select-trigger]';

            const diaBtn = await page.$(selector);
            if (diaBtn) {
                await diaBtn.click();
                logger.info(`Selector de día para fecha ${esFechaHasta ? 'hasta' : 'desde'} clickeado usando selector específico`);
            } else {
                logger.error('No se pudo encontrar el selector de día en ninguna forma');
                return false;
            }
        }

        // Esperar a que aparezca el menú desplegable
        await page.waitForTimeout(1000);
        screenshot ?
            await guardarCaptura(page, `menu-dia-${esFechaHasta ? 'hasta' : 'desde'}-abierto`) : false;

        // 2. Seleccionar el día deseado del menú desplegable
        const diaSeleccionado = await page.evaluate((dia) => {
            // Buscar el menú desplegable visible
            const menuDias = document.querySelector('[role="listbox"]');

            if (menuDias) {
                // Buscar la opción del día deseado
                const opciones = Array.from(menuDias.querySelectorAll('[role="option"]'));

                // Primero intentar con valor exacto
                let opcionDia = opciones.find(opcion =>
                    opcion.getAttribute('data-value') === dia ||
                    opcion.getAttribute('data-label') === dia
                );

                // Si no se encuentra, intentar con texto que contenga el día
                if (!opcionDia) {
                    opcionDia = opciones.find(opcion =>
                        opcion.textContent.trim() === dia ||
                        opcion.textContent.trim().includes(dia)
                    );
                }

                if (opcionDia) {
                    opcionDia.click();
                    return `Día ${dia} seleccionado`;
                }

                // Si no se encuentra el día específico, tomar el primero disponible
                if (opciones.length > 0) {
                    opciones[0].click();
                    return `No se encontró el día ${dia}. Se seleccionó el día ${opciones[0].textContent.trim()}`;
                }

                return `No se encontró el día ${dia} en las opciones`;
            }

            return 'No se encontró el menú desplegable de días';
        }, diaDeseado);

        logger.info(diaSeleccionado);

        // Esperar a que se cierre el menú desplegable
        await page.waitForTimeout(1000);
        screenshot ?
            await guardarCaptura(page, `despues-seleccionar-dia-${esFechaHasta ? 'hasta' : 'desde'}`) : false;

        return diaSeleccionado.includes(`Día ${diaDeseado} seleccionado`) ||
            diaSeleccionado.includes('Se seleccionó el día');
    } catch (error) {
        logger.error(`Error al seleccionar día: ${error.message}`);
        return false;
    }
}

/**
 * Selecciona un mes del selector desplegable
 * @param {Page} page - Instancia de página de Puppeteer
 * @param {string} mesDeseado - Mes a seleccionar (ej: "Ene", "Feb", "Mar")
 * @param {boolean} esFechaHasta - Indica si es para la fecha hasta (segundo selector)
 * @returns {boolean} - true si se seleccionó correctamente
 */
async function seleccionarMes(page, mesDeseado = "Mar", esFechaHasta = false, screenshot) {
    try {
        logger.info(`Intentando seleccionar el mes: ${mesDeseado} para fecha ${esFechaHasta ? 'hasta' : 'desde'}`);

        // 1. Hacer clic en el selector de mes para abrir el menú desplegable
        const mesSelector = await page.evaluate((esFechaHasta) => {
            // Buscar todos los botones combobox que tengan un span con texto de mes
            const botones = Array.from(document.querySelectorAll('button[role="combobox"]'));

            // Identificar los botones que contienen meses
            const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sept', 'Oct', 'Nov', 'Dic'];
            const botonesMes = botones.filter(btn => {
                const span = btn.querySelector('span');
                return span && meses.some(mes => span.textContent.includes(mes));
            });

            // Seleccionar el botón correspondiente según sea fecha desde o hasta
            if (botonesMes.length >= 2 && esFechaHasta) {
                botonesMes[1].click();
                return `Botón de mes para fecha hasta clickeado: ${botonesMes[1].textContent.trim()}`;
            } else if (botonesMes.length > 0) {
                botonesMes[0].click();
                return `Botón de mes para fecha desde clickeado: ${botonesMes[0].textContent.trim()}`;
            }

            return null;
        }, esFechaHasta);

        logger.info(mesSelector || 'No se pudo encontrar o hacer clic en el selector de mes');

        if (!mesSelector) {
            // Intento alternativo: buscar por el aspecto visual específico del botón
            const selector = esFechaHasta
                ? 'div.mb-10:nth-child(3) button[data-select-trigger]:nth-child(2), button[aria-controls="BIJ6WNPV1a"], div:contains("Fecha hasta") ~ div button[data-select-trigger]:nth-child(2)'
                : 'div.mb-10:nth-child(2) button[data-select-trigger]:nth-child(2), button[aria-controls="URP4yAQqrI"], div:contains("Fecha desde") ~ div button[data-select-trigger]:nth-child(2)';

            const mesBtn = await page.$(selector);
            if (mesBtn) {
                await mesBtn.click();
                logger.info(`Selector de mes para fecha ${esFechaHasta ? 'hasta' : 'desde'} clickeado usando selector específico`);
            } else {
                logger.error('No se pudo encontrar el selector de mes en ninguna forma');
                return false;
            }
        }

        // Esperar a que aparezca el menú desplegable
        await page.waitForTimeout(1000);
        screenshot ?
            await guardarCaptura(page, `menu-mes-${esFechaHasta ? 'hasta' : 'desde'}-abierto`) : false;

        // 2. Seleccionar el mes deseado del menú desplegable
        const mesSeleccionado = await page.evaluate((mes) => {
            // Buscar el menú desplegable de meses
            const menuMeses = document.querySelector('[role="listbox"]');

            if (menuMeses) {
                // Buscar la opción del mes deseado
                const opciones = Array.from(menuMeses.querySelectorAll('[role="option"]'));
                const opcionMes = opciones.find(opcion =>
                    opcion.textContent.trim().includes(mes) ||
                    opcion.getAttribute('data-label') === mes
                );

                if (opcionMes) {
                    opcionMes.click();
                    return `Mes ${mes} seleccionado`;
                }

                return `No se encontró el mes ${mes} en las opciones`;
            }

            return 'No se encontró el menú desplegable de meses';
        }, mesDeseado);

        logger.info(mesSeleccionado);

        // Esperar a que se cierre el menú desplegable
        await page.waitForTimeout(1000);
        screenshot ?
            await guardarCaptura(page, `despues-seleccionar-mes-${esFechaHasta ? 'hasta' : 'desde'}`) : false;

        return mesSeleccionado.includes(`Mes ${mesDeseado} seleccionado`);
    } catch (error) {
        logger.error(`Error al seleccionar mes: ${error.message}`);
        return false;
    }
}

/**
 * Selecciona un año del selector desplegable
 * @param {Page} page - Instancia de página de Puppeteer
 * @param {string} anioDeseado - Año a seleccionar (ej: "2024", "2025")
 * @param {boolean} esFechaHasta - Indica si es para la fecha hasta (segundo selector)
 * @returns {boolean} - true si se seleccionó correctamente
 */
async function seleccionarAnio(page, anioDeseado = "2024", esFechaHasta = false, screenshot) {
    try {
        logger.info(`Intentando seleccionar el año: ${anioDeseado} para fecha ${esFechaHasta ? 'hasta' : 'desde'}`);

        // 1. Hacer clic en el selector de año para abrir el menú desplegable
        const anioSelector = await page.evaluate((esFechaHasta) => {
            // Buscar etiquetas de fecha
            const labels = Array.from(document.querySelectorAll('label'));
            const etiquetaFecha = esFechaHasta
                ? labels.find(label => label.textContent.includes('Fecha hasta'))
                : labels.find(label => label.textContent.includes('Fecha desde'));

            let contenedor;
            if (etiquetaFecha) {
                // Obtener el contenedor asociado a la etiqueta
                contenedor = etiquetaFecha.nextElementSibling || etiquetaFecha.parentElement.querySelector('.flex.gap-3');
            }

            // Si encontramos el contenedor específico
            if (contenedor) {
                // Buscar el botón de año en este contenedor
                const botonesAnio = Array.from(contenedor.querySelectorAll('button')).filter(btn =>
                    /^\d{4}$/.test(btn.textContent.trim()) ||
                    (btn.textContent.trim().length <= 6 && /\d{4}/.test(btn.textContent.trim()))
                );

                if (botonesAnio.length > 0) {
                    botonesAnio[0].click();
                    return `Botón de año para fecha ${esFechaHasta ? 'hasta' : 'desde'} clickeado: ${botonesAnio[0].textContent.trim()}`;
                }

                // Intento alternativo: buscar botón con atributos específicos
                const botonPopover = contenedor.querySelector('button[data-popover-trigger], button[data-button-root]');
                if (botonPopover) {
                    botonPopover.click();
                    return `Botón de año (popover) para fecha ${esFechaHasta ? 'hasta' : 'desde'} clickeado: ${botonPopover.textContent.trim()}`;
                }
            }

            // Si no encontramos por contenedor específico, buscar todos los botones de año
            const todosLosBotones = Array.from(document.querySelectorAll('button'));
            const botonesAnio = todosLosBotones.filter(btn =>
                /^\d{4}$/.test(btn.textContent.trim()) ||
                (btn.textContent.trim().length <= 6 && /\d{4}/.test(btn.textContent.trim()))
            );

            // Si hay al menos dos botones (uno para desde, otro para hasta)
            if (botonesAnio.length >= 2 && esFechaHasta) {
                botonesAnio[1].click();
                return `Segundo botón de año clickeado: ${botonesAnio[1].textContent.trim()}`;
            } else if (botonesAnio.length > 0) {
                botonesAnio[0].click();
                return `Primer botón de año clickeado: ${botonesAnio[0].textContent.trim()}`;
            }

            return null;
        }, esFechaHasta);

        logger.info(anioSelector || 'No se pudo encontrar o hacer clic en el selector de año');

        if (!anioSelector) {
            // Intento alternativo con selector específico
            const selector = esFechaHasta
                ? 'div.mb-10:nth-child(3) button[data-button-root], div.mb-10:nth-child(3) button[data-popover-trigger], div:contains("Fecha hasta") ~ div button[data-button-root]'
                : 'div.mb-10:nth-child(2) button[data-button-root], div.mb-10:nth-child(2) button[data-popover-trigger], div:contains("Fecha desde") ~ div button[data-button-root]';

            const anioBtn = await page.$(selector);
            if (anioBtn) {
                await anioBtn.click();
                logger.info(`Selector de año para fecha ${esFechaHasta ? 'hasta' : 'desde'} clickeado usando selector específico`);
            } else {
                logger.error('No se pudo encontrar el selector de año en ninguna forma');
                return false;
            }
        }

        // Esperar a que aparezca el menú desplegable
        await page.waitForTimeout(1000);
        screenshot ?
            await guardarCaptura(page, `menu-anio-${esFechaHasta ? 'hasta' : 'desde'}-abierto`) : false;

        // 2. Buscar y hacer clic en el año deseado
        const anioSeleccionado = await page.evaluate((anio) => {
            // Primero, intentar encontrar el menú desplegable de años
            let menuAnios = document.querySelector('[data-cmdk-root], [data-portal][data-state="open"]');

            if (!menuAnios) {
                // Probar con otros selectores para el menú
                const posiblesMenus = document.querySelectorAll('[data-portal], [role="dialog"], [data-popover-content]');
                for (const menu of posiblesMenus) {
                    if (menu.textContent.includes(anio)) {
                        menuAnios = menu;
                        break;
                    }
                }
            }

            if (menuAnios) {
                // Buscar elementos que contengan el año deseado
                const items = menuAnios.querySelectorAll('[data-cmdk-item], [role="option"]');
                let itemAnioEncontrado = null;

                for (const item of items) {
                    if (item.textContent.trim() === anio || item.getAttribute('data-value') === anio) {
                        itemAnioEncontrado = item;
                        break;
                    }
                }

                if (itemAnioEncontrado) {
                    // Hacer clic en el año encontrado
                    itemAnioEncontrado.click();
                    return `Año ${anio} seleccionado correctamente`;
                } else {
                    // Si no se encuentra directamente, intentar buscar en el contenido de texto
                    const elementos = Array.from(menuAnios.querySelectorAll('*'));
                    for (const elemento of elementos) {
                        if (elemento.textContent.trim() === anio) {
                            elemento.click();
                            return `Año ${anio} seleccionado a través de búsqueda de texto`;
                        }
                    }

                    return `No se encontró el año ${anio} en las opciones`;
                }
            }

            return 'No se encontró el menú desplegable de años';
        }, anioDeseado);

        logger.info(anioSeleccionado);

        // Esperar a que se cierre el menú desplegable
        await page.waitForTimeout(1000);
        screenshot ?
            await guardarCaptura(page, `despues-seleccionar-anio-${esFechaHasta ? 'hasta' : 'desde'}`) : false;

        return anioSeleccionado.includes(`Año ${anioDeseado} seleccionado`);
    } catch (error) {
        logger.error(`Error al seleccionar año: ${error.message}`);
        return false;
    }
}

/**
 * Completa una fecha (día, mes y año)
 * @param {Page} page - Instancia de página de Puppeteer
 * @param {Object} fecha - Objeto con día, mes y año
 * @param {boolean} esFechaHasta - Indica si es para la fecha hasta
 */
async function completarUnaFecha(page, fecha, esFechaHasta = false, screenshot) {
    // Configurar valores por defecto
    const fechaConfig = {
        dia: fecha.dia || '01',
        mes: fecha.mes || 'Ene',
        anio: fecha.anio || '2024'
    };

    const tipoFecha = esFechaHasta ? 'hasta' : 'desde';
    logger.info(`Configurando fecha ${tipoFecha}: ${JSON.stringify(fechaConfig)}`);

    // Seleccionar día
    const diaOk = await seleccionarDia(page, fechaConfig.dia, esFechaHasta, screenshot);
    if (!diaOk) {
        logger.error(`No se pudo seleccionar el día ${fechaConfig.dia} para fecha ${tipoFecha}`);
    }

    // Seleccionar mes
    const mesOk = await seleccionarMes(page, fechaConfig.mes, esFechaHasta, screenshot);
    if (!mesOk) {
        logger.error(`No se pudo seleccionar el mes ${fechaConfig.mes} para fecha ${tipoFecha}`);
    }

    // Seleccionar año
    const anioOk = await seleccionarAnio(page, fechaConfig.anio, esFechaHasta, screenshot);
    if (!anioOk) {
        logger.error(`No se pudo seleccionar el año ${fechaConfig.anio} para fecha ${tipoFecha}`);
    }

    return {
        dia: diaOk,
        mes: mesOk,
        anio: anioOk
    };
}

/**
 * Función principal para completar las fechas (desde y hasta)
 */
async function completarFechas(page, fechaDesde = {}, fechaHasta = {}, screenshot) {

    try {
        // Completar fecha desde
        const resultadoDesde = await completarUnaFecha(page, fechaDesde, false, screenshot);

        // Completar fecha hasta
        const resultadoHasta = await completarUnaFecha(page, fechaHasta, true, screenshot);

        // Verificar el estado actual del formulario
        const estadoFormulario = await page.evaluate(() => {
            // Obtener todos los valores de los campos de fecha
            const valores = Array.from(document.querySelectorAll('button[role="combobox"] span[data-select-value], button[data-popover-trigger], button[data-button-root]'))
                .map(el => ({
                    tipo: el.tagName,
                    valor: el.textContent.trim()
                }));

            return {
                estado: 'Fechas configuradas',
                valores
            };
        });

        logger.info('Estado del formulario después de configurar fechas:');
        logger.info(JSON.stringify(estadoFormulario, null, 2));
        screenshot ?
            await guardarCaptura(page, 'despues-configurar-todas-fechas') : false;

        return {
            status: 'success',
            message: 'Fechas configuradas correctamente',
            detalles: {
                fechaDesde: resultadoDesde,
                fechaHasta: resultadoHasta,
                estadoFormulario
            }
        };
    } catch (error) {
        logger.error(`Error al completar fechas: ${error.message}`);
        return { error: error.message };
    }
}

/**
 * Hace clic en el botón Calcular
 * @param {Page} page - Instancia de página de Puppeteer
 * @returns {boolean} - true si se hizo clic correctamente
 */
async function clickBotonCalcular(page, screenshot) {
    try {
        logger.info('Intentando hacer clic en el botón Calcular...');

        const botonClickeado = await page.evaluate(() => {
            // Identificar el botón Calcular usando diferentes métodos

            // 1. Por texto
            const botones = Array.from(document.querySelectorAll('button'));
            const botonCalcular = botones.find(btn =>
                btn.textContent.includes('Calcular')
            );

            if (botonCalcular) {
                botonCalcular.click();
                return `Botón Calcular encontrado por texto y clickeado: ${botonCalcular.textContent.trim()}`;
            }

            // 2. Por clase (si es que tiene una clase específica de botón primario)
            const botonPrimario = document.querySelector('button.bg-\\[\\#5A5A5A\\], button.btn-primary, button.calcular');
            if (botonPrimario) {
                botonPrimario.click();
                return `Botón Calcular encontrado por clase y clickeado: ${botonPrimario.textContent.trim()}`;
            }

            // 3. Por posición en el formulario (último botón)
            const todosLosBotones = Array.from(document.querySelectorAll('form button, .form button'));
            if (todosLosBotones.length > 0) {
                const ultimoBoton = todosLosBotones[todosLosBotones.length - 1];
                ultimoBoton.click();
                return `Último botón del formulario clickeado: ${ultimoBoton.textContent.trim()}`;
            }

            return null;
        });

        logger.info(botonClickeado || 'No se pudo encontrar o hacer clic en el botón Calcular');

        if (!botonClickeado) {
            // Intento alternativo con XPath
            try {
                const [botonXPath] = await page.$x('//button[contains(text(), "Calcular")]');
                if (botonXPath) {
                    await botonXPath.click();
                    logger.info('Botón Calcular clickeado usando XPath');
                    return true;
                }
            } catch (xpathError) {
                logger.error(`Error con XPath: ${xpathError.message}`);
            }

            // Intento final usando el selector CSS exacto del botón Calcular
            const botonFinal = await page.$('button.inline-flex.items-center.justify-center.whitespace-nowrap.rounded-md.text-lg.font-medium.transition-colors.duration-300.focus-visible\\:outline-none.disabled\\:pointer-events-none.disabled\\:opacity-50.bg-\\[\\#5A5A5A\\].text-white.hover\\:bg-\\[\\#8D8D8D\\].h-\\[51px\\].px-9.py-2');
            if (botonFinal) {
                await botonFinal.click();
                logger.info('Botón Calcular clickeado usando selector CSS específico');
                return true;
            }

            logger.error('No se pudo encontrar el botón Calcular en ninguna forma');
            return false;
        }

        await page.waitForTimeout(1000);
        screenshot ?
            await guardarCaptura(page, 'despues-click-calcular') : false;

        return true;
    } catch (error) {
        logger.error(`Error al hacer clic en el botón Calcular: ${error.message}`);
        return false;
    }
}

/**
 * Extrae los resultados del cálculo de interés de la tabla
 * @param {Page} page - Instancia de página de Puppeteer
 * @returns {Object} - Resultados del cálculo en formato estructurado
 */
async function extraerResultados(page, screenshot) {
    try {
        logger.info('Extrayendo resultados del cálculo...');
        // Esperar a que la tabla de resultados se cargue
        await page.waitForTimeout(2000);

        // Obtener tanto la información general como los datos de la tabla
        const resultados = await page.evaluate(() => {
            // Función auxiliar para convertir texto a número, eliminando símbolos no numéricos
            function convertirANumero(texto) {
                if (!texto) return 0;
                // Eliminar cualquier carácter que no sea dígito, punto o coma
                const limpio = texto.replace(/[^\d.,]/g, '');
                // Reemplazar coma por punto (en caso de formato europeo)
                const normalizado = limpio.replace(',', '.');
                // Convertir a número
                return parseFloat(normalizado);
            }

            // 1. Extraer información general (resumen)
            const infoResumen = {};

            // Buscar elementos que contengan información de resumen
            const elementosResumen = document.querySelectorAll('.card, .panel, .summary, .resumen, .alert, [role="alert"]');
            if (elementosResumen.length > 0) {
                Array.from(elementosResumen).forEach(elemento => {
                    // Intentar extraer pares clave-valor
                    const labels = elemento.querySelectorAll('strong, b, .label, dt, th');
                    const values = elemento.querySelectorAll('.value, dd, td');

                    if (labels.length > 0 && values.length > 0) {
                        for (let i = 0; i < Math.min(labels.length, values.length); i++) {
                            infoResumen[labels[i].textContent.trim()] = values[i].textContent.trim();
                        }
                    }
                });
            }

            // 2. Extraer datos de la tabla
            const datosTabla = [];

            // Buscar la tabla de resultados
            const tablas = document.querySelectorAll('table');
            if (tablas.length > 0) {
                // Para cada tabla encontrada (normalmente debería ser solo una)
                Array.from(tablas).forEach(tabla => {
                    // Buscar todas las filas excepto posibles encabezados
                    const filas = tabla.querySelectorAll('tbody tr, tr:not(thead tr)');

                    // Para cada fila, extraer la información requerida
                    Array.from(filas).forEach(fila => {
                        const celdas = fila.querySelectorAll('td');
                        if (celdas.length >= 6) { // Asegurarnos de que hay suficientes celdas
                            try {
                                const tasaTexto = celdas[3].textContent.trim();
                                const tasaNumero = convertirANumero(tasaTexto);
                                const dias = Number(celdas[2].textContent.trim());
                                // Calcular el coeficiente como tasa / 30
                                const coeficiente = tasaNumero / 30;

                                if (dias > 0) {
                                    datosTabla.push({
                                        fechaInicio: celdas[0].textContent.trim(),
                                        fechaFin: celdas[1].textContent.trim(),
                                        dias: dias,
                                        tasa: tasaNumero, // Tasa como número
                                        tasaTexto: tasaTexto, // Mantener el texto original por si acaso
                                        coeficiente: coeficiente, // Coeficiente calculado
                                        intereses: celdas[5].textContent.trim()
                                    });
                                }
                            } catch (e) {
                                // Si hay un error al procesar la fila, incluirla con los valores originales
                                datosTabla.push({
                                    fechaInicio: celdas[0].textContent.trim(),
                                    fechaFin: celdas[1].textContent.trim(),
                                    dias: celdas[2].textContent.trim(),
                                    tasa: celdas[3].textContent.trim(),
                                    coeficiente: 0, // Valor por defecto en caso de error
                                    intereses: celdas[5].textContent.trim(),
                                    error: "Error al convertir tasa a número"
                                });
                            }
                        }
                    });
                });
            }

            // 3. Extraer encabezados de la tabla (para entender mejor los datos)
            let encabezados = [];
            const theads = document.querySelectorAll('thead tr');
            if (theads.length > 0) {
                encabezados = Array.from(theads[0].querySelectorAll('th')).map(th => th.textContent.trim());
            }

            // 4. Extraer posible información de totales o resumen final
            const infoTotales = {};
            const filasResumen = document.querySelectorAll('tfoot tr, tr.total, tr.resumen');
            if (filasResumen.length > 0) {
                const celdas = filasResumen[0].querySelectorAll('td');
                if (celdas.length >= 6) {
                    try {
                        infoTotales.totalDias = celdas[2].textContent.trim();
                        infoTotales.tasaPromedio = convertirANumero(celdas[3].textContent.trim());
                        infoTotales.tasaPromedioTexto = celdas[3].textContent.trim();
                        infoTotales.totalIntereses = celdas[5].textContent.trim();
                    } catch (e) {
                        infoTotales.error = "Error al procesar totales";
                        infoTotales.totalDias = celdas[2]?.textContent.trim() || "";
                        infoTotales.tasaPromedio = celdas[3]?.textContent.trim() || "";
                        infoTotales.totalIntereses = celdas[5]?.textContent.trim() || "";
                    }
                }
            }

            return {
                resumen: infoResumen,
                encabezados: encabezados,
                datos: datosTabla,
                totales: infoTotales,
                // Incluir todo el HTML de la tabla para posible análisis posterior
                htmlTabla: document.querySelector('table')?.outerHTML || 'No se encontró tabla'
            };
        });

        logger.info(`Se extrajeron ${resultados.datos?.length || 0} filas de datos de la tabla`);

        // Verificar y mostrar el tipo de dato de la tasa
        if (resultados.datos && resultados.datos.length > 0) {
            logger.info(`Ejemplo de dato extraído:`);
            logger.info(`Fecha Inicio: ${resultados.datos[0].fechaInicio}`);
            logger.info(`Tasa: ${resultados.datos[0].tasa} (tipo: ${typeof resultados.datos[0].tasa})`);
            logger.info(`Coeficiente: ${resultados.datos[0].coeficiente} (tipo: ${typeof resultados.datos[0].coeficiente})`);
        }

        // Guardar captura y HTML completo para referencia
        screenshot ?
            await guardarCaptura(page, 'resultados-tabla') : false;
        await guardarHTML(page, 'resultados-tabla');

        // Guardar los resultados extraídos en un archivo JSON
        try {
            const jsonPath = path.join(process.cwd(), 'server', 'files', 'resultados-interes.json');
            await fs.writeFile(jsonPath, JSON.stringify(resultados, null, 2));
            logger.info('Resultados guardados en server/files/resultados-interes.json');
        } catch (writeError) {
            logger.error(`Error al guardar JSON: ${writeError.message}`);
        }

        return resultados;
    } catch (error) {
        logger.error(`Error al extraer resultados: ${error.message}`);
        return { error: error.message };
    }
}


/**
 * Expande los resultados para tener un registro por día con la tasa correspondiente
 * @param {Object} resultados - Resultados obtenidos del scraping
 * @returns {Array} - Array de objetos con fecha y tasaActiva para cada día
 */
function expandirResultadosPorDia(resultados, tasa) {

    if (!resultados || !resultados.datos || !Array.isArray(resultados.datos)) {
        logger.error('No hay datos válidos para expandir');
        return [];
    }

    const resultadosExpandidos = [];

    // Para cada periodo de tasa
    resultados.datos.forEach(periodo => {
        try {
            // Convertir fechas de inicio y fin a objetos Date
            const fechaInicio = convertirStringADate(periodo.fechaInicio).fechaDate;
            const fechaFin = convertirStringADate(periodo.fechaFin).fechaDate;

            if (!fechaInicio || !fechaFin) {
                logger.error(`Fechas inválidas para el periodo: ${JSON.stringify(periodo)}`);
                return;
            }

            // Valor de la tasa mensual
            const tasaActiva = periodo.tasa;

            // Para cada día entre fechaInicio y fechaFin
            const fechaActual = new Date(fechaInicio);
            while (fechaActual <= fechaFin) {
                // Crear registro para esta fecha
                const registro = {
                    fecha: new Date(fechaActual),
                    fechaISO: new Date(fechaActual).toISOString().replace('Z', '+00:00'),
                    tasaMensual: tasaActiva,
                    [tasa]: periodo.coeficiente
                };

                resultadosExpandidos.push(registro);

                // Avanzar al siguiente día
                fechaActual.setDate(fechaActual.getDate() + 1);
            }
        } catch (error) {
            logger.error(`Error al expandir periodo ${JSON.stringify(periodo)}: ${error.message}`);
        }
    });

    logger.info(`Se generaron ${resultadosExpandidos.length} registros diarios a partir de ${resultados.datos.length} periodos`);
    return resultadosExpandidos;
}

/**
 * Función modificada para adaptar los resultados con un registro por día
 * @param {Object} resultados - Resultados obtenidos del scraping
 * @returns {Object} - Objeto con los resultados originales y expandidos
 */
async function extraerResultadosExpandidosParaMongo(page, screenshot = true, tasa) {

    try {
        // Primero extraer los resultados normales
        const resultadosOriginales = await extraerResultados(page, screenshot);

        // Si hubo un error en la extracción original, devolverlo
        if (resultadosOriginales.error) {
            return resultadosOriginales;
        }

        // Adaptar los resultados al formato del modelo (un registro por periodo)
        const tasasFormateadas = adaptarResultadosAModelo(resultadosOriginales);

        // Expandir los resultados (un registro por día)
        const tasasExpandidas = expandirResultadosPorDia(resultadosOriginales, tasa);

        // Guardar los resultados formateados para MongoDB en archivos JSON
        try {
            const jsonPath = path.join(process.cwd(), 'server', 'files', 'tasas-para-mongo.json');
            await fs.writeFile(jsonPath, JSON.stringify(tasasFormateadas, null, 2));
            logger.info('Resultados adaptados guardados en server/files/tasas-para-mongo.json');

            const jsonPathExpandido = path.join(process.cwd(), 'server', 'files', 'tasas-diarias-para-mongo.json');
            await fs.writeFile(jsonPathExpandido, JSON.stringify(tasasExpandidas, null, 2));
            logger.info('Resultados expandidos guardados en server/files/tasas-diarias-para-mongo.json');
        } catch (writeError) {
            logger.error(`Error al guardar JSON adaptado: ${writeError.message}`);
        }

        // Devolver tanto los resultados originales como los formateados y expandidos
        return {
            resultadosOriginales,
            tasasParaMongo: tasasFormateadas,
            tasasDiariasParaMongo: tasasExpandidas
        };
    } catch (error) {
        logger.error(`Error al adaptar resultados para MongoDB: ${error.message}`);
        return { error: error.message };
    }
}

/**
 * Función principal que ejecuta todo el proceso con parámetros
 * @param {Object} opciones - Opciones para el proceso
 * @param {number} opciones.monto - Monto a ingresar
 * @param {Object} opciones.fechaDesde - Fecha desde con día, mes y año
 * @param {Object} opciones.fechaHasta - Fecha hasta con día, mes y año
 * @param {boolean} opciones.headless - Ejecutar en modo headless (invisible)
 * @param {string} opciones.tipoTasa - Tipo de tasa a seleccionar
 */
async function consejoService(opciones = {}) {
    // Procesar fechas (aceptar tanto formato ISO como objeto estructurado)
    let fechaDesdeObj, fechaHastaObj;

    // Verificar si fechaDesde es una cadena (formato ISO) o un objeto
    if (typeof opciones.fechaDesde === 'string') {
        // Verificar si es formato DD-MM-YYYY
        if (opciones.fechaDesde.match(/^\d{2}-\d{2}-\d{4}$/)) {
            // Formato DD-MM-YYYY, convertir manualmente
            const [dia, mes, anio] = opciones.fechaDesde.split('-');

            // Mapeo de números de mes a abreviaturas en español
            const mesesAbrev = {
                '01': 'Ene', '02': 'Feb', '03': 'Mar', '04': 'Abr', '05': 'May', '06': 'Jun',
                '07': 'Jul', '08': 'Ago', '09': 'Sept', '10': 'Oct', '11': 'Nov', '12': 'Dic'
            };

            fechaDesdeObj = {
                dia: dia,
                mes: mesesAbrev[mes] || 'Ene', // Valor por defecto si no se encuentra
                anio: anio
            };

            logger.info(`Fecha desde DD-MM-YYYY convertida: ${opciones.fechaDesde} → ${JSON.stringify(fechaDesdeObj)}`);
        } else {
            // Es una fecha ISO o en otro formato, usar parseFechaISO
            fechaDesdeObj = parseFechaISO(opciones.fechaDesde);
            logger.info(`Fecha desde ISO convertida: ${opciones.fechaDesde} → ${JSON.stringify(fechaDesdeObj)}`);
        }
    } else {
        // Ya es un objeto, usar directamente o valores por defecto
        fechaDesdeObj = {
            dia: opciones.fechaDesde?.dia || '01',
            mes: opciones.fechaDesde?.mes || 'Ene',
            anio: opciones.fechaDesde?.anio || '2024'
        };
    }

    // Mismo proceso para fechaHasta
    if (typeof opciones.fechaHasta === 'string') {
        // Verificar si es formato DD-MM-YYYY
        if (opciones.fechaHasta.match(/^\d{2}-\d{2}-\d{4}$/)) {
            // Formato DD-MM-YYYY, convertir manualmente
            const [dia, mes, anio] = opciones.fechaHasta.split('-');

            // Mapeo de números de mes a abreviaturas en español
            const mesesAbrev = {
                '01': 'Ene', '02': 'Feb', '03': 'Mar', '04': 'Abr', '05': 'May', '06': 'Jun',
                '07': 'Jul', '08': 'Ago', '09': 'Sept', '10': 'Oct', '11': 'Nov', '12': 'Dic'
            };

            fechaHastaObj = {
                dia: dia,
                mes: mesesAbrev[mes] || 'Ene', // Valor por defecto si no se encuentra
                anio: anio
            };

            logger.info(`Fecha hasta DD-MM-YYYY convertida: ${opciones.fechaHasta} → ${JSON.stringify(fechaHastaObj)}`);
        } else {
            // Es una fecha ISO o en otro formato, usar parseFechaISO
            fechaHastaObj = parseFechaISO(opciones.fechaHasta);
            logger.info(`Fecha hasta ISO convertida: ${opciones.fechaHasta} → ${JSON.stringify(fechaHastaObj)}`);
        }
    } else {
        // Ya es un objeto, usar directamente o valores por defecto
        fechaHastaObj = {
            dia: opciones.fechaHasta?.dia || '01',
            mes: opciones.fechaHasta?.mes || 'Mar',
            anio: opciones.fechaHasta?.anio || '2025'
        };
    }

    // Valores por defecto
    const config = {
        monto: opciones.monto || 10000,
        fechaDesde: fechaDesdeObj,
        fechaHasta: fechaHastaObj,
        headless: opciones.headless !== undefined ? opciones.headless : false,
        tipoTasa: opciones.tipoTasa || 'tasa_activa_BN',
        screenshot: opciones.screenshot || false,
        usarFechaISO: opciones.usarFechaISO !== undefined ? opciones.usarFechaISO : true,
        database: opciones.database
    };


    let browser;
    try {
        logger.info('Iniciando proceso completo de cálculo de interés...');
        logger.info('Configuración:');
        logger.info(JSON.stringify(config, null, 2));

        // Configurar y lanzar navegador
        browser = await puppeteer.launch({
            headless: configPuppeteer.headless,
            args: configPuppeteer.args,
            defaultViewport: configPuppeteer.defaultViewport,
            executablePath: configPuppeteer.executablePath,
        });

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(60000);

        // Navegar a la página
        const url = 'https://consejo.jusbaires.gob.ar/servicios/calculo-de-interes/';
        logger.info(`Navegando a la página: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Hacer clic en el botón de tasa activa
        logger.info(`Seleccionando tipo de tasa: ${config.tipoTasa}`);
        const tasaSeleccionada = await page.evaluate((tipoTasa) => {
            const btnTasa = document.getElementById(tipoTasa);
            if (btnTasa) {
                btnTasa.click();
                return `Tasa seleccionada por ID: ${tipoTasa}`;
            }

            // Intentar por otros atributos
            const botonesTasa = Array.from(document.querySelectorAll('button[data-value], button[role="radio"]'));
            const botonEncontrado = botonesTasa.find(btn =>
                btn.getAttribute('data-value') === tipoTasa ||
                btn.id === tipoTasa ||
                btn.textContent.includes(tipoTasa.replace('_', ' '))
            );

            if (botonEncontrado) {
                botonEncontrado.click();
                return `Tasa seleccionada por atributo: ${tipoTasa}`;
            }

            return `No se encontró el botón para la tasa: ${tipoTasa}`;
        }, config.tipoTasa);

        logger.info(tasaSeleccionada);
        await page.waitForTimeout(1000);

        // Hacer clic en el botón Siguiente
        logger.info('Haciendo clic en el botón Siguiente...');
        const siguienteClickeado = await page.evaluate(() => {
            const botones = Array.from(document.querySelectorAll('button'));
            const btnSiguiente = botones.find(btn =>
                btn.textContent.includes('Siguiente') ||
                btn.className.includes('bg-[#5A5A5A]')
            );

            if (btnSiguiente) {
                btnSiguiente.click();
                return `Botón Siguiente clickeado: ${btnSiguiente.textContent.trim()}`;
            }

            return 'No se encontró el botón Siguiente';
        });

        logger.info(siguienteClickeado);

        // Esperar a que cargue el formulario
        await page.waitForTimeout(3000);
        config.screenshot ? await guardarCaptura(page, 'formulario-cargado') : false;

        // Ingresar monto
        await ingresarMonto(page, config.monto, config.screenshot);

        // Configurar fechas
        await completarFechas(page, config.fechaDesde, config.fechaHasta, config.screenshot);

        // Hacer clic en el botón Calcular
        await clickBotonCalcular(page, config.screenshot);

        // Extraer resultados
        const resultadosJson = await extraerResultados(page, config.screenshot);


        // Usar la nueva función que incluye los resultados expandidos
        const resultados = await extraerResultadosExpandidosParaMongo(page, config.screenshot, config.database);

        return {
            status: 'success',
            message: 'Proceso completado correctamente',
            configuracion: config,
            resultados: resultados.resultadosOriginales,
            tasasParaMongo: resultados.tasasParaMongo,
            tasasDiariasParaMongo: resultados.tasasDiariasParaMongo
        };

    } catch (error) {
        logger.error(`Error durante el proceso: ${error.message}`);
        if (browser) {
            const page = (await browser.pages())[0];
            if (page) {
                await guardarCaptura(page, 'error-proceso');
                await guardarHTML(page, 'error-proceso');
            }
        }
        return { error: error.message };
    } finally {
        if (browser) {
            await browser.close();
            logger.info('Navegador cerrado');
        }
    }
}



async function mainConsejoService(opciones = {}) {
    //console.log(opciones)
    try {

        let fechaDesde, fechaHasta;

        // Si se proporciona fechaDesde, usarla; de lo contrario, calcularla
        if (opciones.fechaDesde) {
            // Usar la fecha proporcionada
            fechaDesde = moment(opciones.fechaDesde).toISOString();

            // Validar que la fecha es válida
            if (!moment(fechaDesde).isValid()) {
                throw new Error('La fecha de inicio proporcionada no es válida');
            }

            logger.info(`Usando fecha de inicio proporcionada: ${fechaDesde}`);
        } else {
            // Calcular la fecha de inicio según la lógica original
            // Obtener último dato
            const lastData = await getUltimaTasaHastaFecha(opciones.database || "tasaActivaBNA");

            // Validar que se obtuvo un dato válido
            if (!lastData || !lastData.fecha) {
                throw new Error('No se encontró un registro válido de tasaActivaBNA');
            }

            // Convertir a formato ISO
            const lastDataFechaISO = moment(lastData.fecha).toISOString();

            // Obtener el día siguiente
            fechaDesde = obtenerDiaSiguiente(lastData.fecha);

            logger.info(`Calculando fecha de inicio automáticamente. Último dato: ${lastDataFechaISO}, fecha de inicio: ${fechaDesde}`);
        }

        // Si se proporciona fechaHasta, usarla; de lo contrario, usar la fecha actual
        if (opciones.fechaHasta) {
            // Usar la fecha proporcionada
            fechaHasta = moment(opciones.fechaHasta).toISOString();

            // Validar que la fecha es válida
            if (!moment(fechaHasta).isValid()) {
                throw new Error('La fecha final proporcionada no es válida');
            }

            logger.info(`Usando fecha final proporcionada: ${fechaHasta}`);
        } else {
            // Usar la fecha actual
            fechaHasta = obtenerFechaActualISO();
            logger.info(`Usando fecha actual como fecha final: ${fechaHasta}`);
        }

        // Validar que todas son fechas válidas
        if (!moment(fechaDesde).isValid() || !moment(fechaHasta).isValid()) {
            throw new Error('Una o más fechas no son válidas');
        }

        // Validar que la fecha de inicio no sea posterior a la fecha final
        //console.log("Fechas", fechaDesde, fechaHasta)
        //console.log(moment(fechaDesde).isSameOrAfter(moment(fechaHasta)))
        if (moment(fechaDesde).isSameOrAfter(moment(fechaHasta))) {
            logger.info(`Tasa actualizada. La fecha de inicio (${fechaDesde}) es posterior o igual a la fecha final (${fechaHasta})`);
            return "Tasa actualizada";
        }

        // Si todas las validaciones pasan, continuar con la lógica
        logger.info(`Buscando datos de tasas desde ${fechaDesde} hasta ${fechaHasta}`);



        const tasaActivaBna = await consejoService({
            monto: 15000,
            fechaDesde: fechaDesde,
            fechaHasta: fechaHasta,
            headless: false,
            tipoTasa: opciones.tasa || 'tasa_activa_BN',
            screenshot: opciones.screenshot || false,
            usarFechaISO: false,
            database: opciones.database || "tasaActivaBNA",
        });

        const results = tasaActivaBna.tasasDiariasParaMongo;
        //console.log(results)
        const resultsBulkOps = await bulkUpsertTasas(results, 'Consejo');

        return resultsBulkOps;

    } catch (error) {
        logger.error(`Error en la tarea de actualización de tasas: ${error}`)
    }
}



async function findMissingDataService(tasa, database) {
    try {

        const resultFechasFaltantes = await verificarFechasFaltantes(database)
        //console.log(tasa, database, resultFechasFaltantes)
        logger.info(`Resultado de búsqueda de fechas faltantes: ${resultFechasFaltantes.diasFaltantes}`);
        if (resultFechasFaltantes.diasFaltantes > 0) {
            const resultRango = await obtenerRangoFechasFaltantes(database);
            logger.info(`Rango de fechas faltantes: ${resultRango.fechaDesdeFormateada} a ${resultRango.fechaHastaFormateada}`)
            const resultScraping = await mainConsejoService({ fechaDesde: resultRango.fechaDesde, fechaHasta: resultRango.fechaHasta, tasa, database });
            const updateConfig = await procesarActualizacionTasas(database, resultScraping)
        }
        return {
            message: `Días faltantes para ${tasa}: ${resultFechasFaltantes.diasFaltantes}`
        }
    } catch (error) {
        logger.error(error)
    }
}

module.exports = {
    ingresarMonto,
    seleccionarDia,
    seleccionarMes,
    seleccionarAnio,
    completarUnaFecha,
    completarFechas,
    clickBotonCalcular,
    extraerResultados,
    consejoService,
    mainConsejoService,
    findMissingDataService,
};