const puppeteer = require('puppeteer');
const moment = require("moment");
const logger = require('../../../utils/logger');
const Tasas = require('../../../models/tasas');
const TasasConfig = require('../../../models/tasasConfig');
const { actualizarFechasFaltantes, verificarFechasFaltantes } = require('../../../controllers/tasasConfigController');
const { obtenerFechaActualISO } = require('../../../utils/format');
const { getPuppeteerConfig } = require('../../../config/puppeteer');
const { waitRandom, typeHuman } = require('../colegioServiceFunctions');
require('dotenv').config();

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
 * Clase para realizar scraping del sitio tasas.cpacf.org.ar
 */
class CPACFScraper {
    constructor(options = {}) {
        this.baseUrl = process.env.URL_CPA;
        this.credentials = {
            dni: process.env.DU_01,
            tomo: process.env.TREG_01,
            folio: process.env.FREG_01,
        };
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.calculatorFormInfo = null;
    }

    /**
     * Inicializa el navegador y la página
     */
    async initialize() {
        try {
            logger.info('Iniciando navegador con configuración mejorada...');

            // Configuración mejorada para evitar detección
            const puppeteerOpts = {
                headless: configPuppeteer.headless,
                args: configPuppeteer.args,
                defaultViewport: configPuppeteer.defaultViewport,
                executablePath: configPuppeteer.executablePath,
                ignoreHTTPSErrors: true,
                slowMo: 50, // Ralentiza toda la navegación
            };

            this.browser = await puppeteer.launch(puppeteerOpts);
            this.page = await this.browser.newPage();

            // Simular navegador real añadiendo webgl y otras propiedades
            await this.page.evaluateOnNewDocument(() => {
                // Ocultar que estamos usando Puppeteer/Automation
                Object.defineProperty(navigator, 'webdriver', { get: () => false });

                // Simular plugins (como haría un navegador real)
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [
                        { name: 'Chrome PDF Plugin' },
                        { name: 'Chrome PDF Viewer' },
                        { name: 'Native Client' },
                    ],
                });

                // Simular idiomas
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['es-ES', 'es', 'en-US', 'en'],
                });

                // Simular webgl
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function (parameter) {
                    if (parameter === 37445) return 'Intel Inc.';
                    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
                    return getParameter.apply(this, arguments);
                };
            });

            // Configurar timeouts más largos
            await this.page.setDefaultNavigationTimeout(120000); // 2 minutos
            await this.page.setDefaultTimeout(60000); // 1 minuto

            // Añadir listeners para errores de la página
            this.page.on('error', err => {
                logger.error('Error en la página:', err);
            });

            this.page.on('console', msg => {
                if (msg.type() === 'error' || msg.type() === 'warning') {
                    logger.info(`${msg.type()}: ${msg.text()}`);
                }
            });

            // Configurar cache y cookies
            await this.page.setCacheEnabled(true);

            return true;
        } catch (error) {
            logger.error('Error al inicializar el scraper:', error);
            await this.close();
            throw error;
        }
    }

    /**
     * Realiza el login en el sitio
     * @returns {Promise<boolean>} - Si el login fue exitoso
     */
    async login() {
        try {
            if (!this.browser || !this.page) {
                await this.initialize();
            }

            logger.info('Navegando a la página de login...');

            // Esperar un tiempo antes de navegar
            await waitRandom(2000, 4000);

            // Navegar con opciones mejoradas y esperar a que cargue completamente
            await this.page.goto(this.baseUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            // Esperar un tiempo aleatorio después de cargar
            await waitRandom(3000, 5000);

            // Verificar si los campos de login existen con tiempo de espera
            await this.page.waitForSelector('input[name="dni"]', { timeout: 30000 });

            // Verificar credenciales
            if (!this.credentials.dni || !this.credentials.tomo || !this.credentials.folio) {
                throw new Error('Faltan credenciales para el login (DNI, TOMO o FOLIO)');
            }

            logger.info('Completando el formulario de login...');

            // Completar formulario con comportamiento más humano
            await typeHuman(this.page, 'input[name="dni"]', this.credentials.dni);
            await waitRandom(800, 1500);

            await typeHuman(this.page, 'input[name="tomo"]', this.credentials.tomo);
            await waitRandom(800, 1500);

            await typeHuman(this.page, 'input[name="folio"]', this.credentials.folio);
            await waitRandom(1000, 2000);

            // Hacer click en el botón de siguiente con comportamiento más humano
            logger.info('Haciendo click en SIGUIENTE...');

            const nextButton = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const nextButton = links.find(link => link.textContent.includes('SIGUIENTE'));
                if (nextButton) {
                    const rect = nextButton.getBoundingClientRect();
                    return {
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2,
                        exists: true
                    };
                } else {
                    return { exists: false };
                }
            });

            if (nextButton.exists) {
                // Mover el mouse hacia el botón gradualmente
                await this.page.mouse.move(
                    nextButton.x - 50 + Math.random() * 20,
                    nextButton.y - 20 + Math.random() * 10,
                    { steps: 10 }
                );

                await waitRandom(300, 700);

                // Completar el movimiento hacia el centro del botón
                await this.page.mouse.move(
                    nextButton.x + Math.random() * 10 - 5,
                    nextButton.y + Math.random() * 10 - 5,
                    { steps: 5 }
                );

                await waitRandom(200, 400);

                // Hacer click
                await this.page.mouse.down();
                await waitRandom(50, 150);
                await this.page.mouse.up();
            } else {
                // Si no encuentra el botón, enviar el formulario
                await this.page.evaluate(() => {
                    document.forms[0].submit();
                });
            }

            // Esperar a que la navegación termine con un timeout generoso
            await this.page.waitForNavigation({
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            await waitRandom(2000, 4000);

            // Verificar si el login fue exitoso
            const currentUrl = this.page.url();
            this.loggedIn = !currentUrl.includes('newLogin');

            if (!this.loggedIn) {
                const errorMessage = await this.page.evaluate(() => {
                    const errorElement = document.querySelector('td[style*="color: red;"]');
                    return errorElement ? errorElement.textContent.trim() : 'Login fallido';
                });

                throw new Error(`Error de login: ${errorMessage}`);
            }

            logger.info('Login exitoso');

            // Esperar un tiempo antes de continuar
            await waitRandom(3000, 5000);

            // Analizar la estructura de la página después del login
            await this.analyzePageStructure();

            return true;
        } catch (error) {

            logger.error('Error durante el login:', error);
            throw error;
        }
    }

    /**
     * Analiza la estructura de la página después del login
     * para identificar las opciones de navegación disponibles
     */
    async analyzePageStructure() {
        try {
            logger.info('Analizando la estructura de la página después del login...');

            // Extraer los enlaces disponibles
            const links = await this.page.evaluate(() => {
                const allLinks = Array.from(document.querySelectorAll('a'));
                return allLinks.map(link => ({
                    text: link.textContent.trim(),
                    href: link.href,
                    onclick: link.getAttribute('onclick')
                })).filter(link => link.text);
            });

            // Extraer los formularios disponibles
            const forms = await this.page.evaluate(() => {
                const allForms = Array.from(document.querySelectorAll('form'));
                return allForms.map(form => ({
                    id: form.id,
                    action: form.action,
                    method: form.method,
                    inputs: Array.from(form.querySelectorAll('input')).map(input => ({
                        name: input.name,
                        type: input.type,
                        id: input.id
                    }))
                }));
            });

            // Extraer las opciones de tasas si están disponibles
            const rateOptions = await this.page.evaluate(() => {
                const rateSelect = document.querySelector('select[name="rate"]');
                if (!rateSelect) return [];

                return Array.from(rateSelect.options).map(option => ({
                    value: option.value,
                    text: option.textContent.trim()
                }));
            });

            // Guarda esta información para uso posterior
            this.pageStructure = { links, forms, rateOptions };

            logger.info(`Encontrados ${links.length} enlaces y ${forms.length} formularios`);
            if (rateOptions && rateOptions.length) {
                logger.info(`Encontradas ${rateOptions.length} opciones de tasas disponibles`);
            }

            return this.pageStructure;
        } catch (error) {
            logger.error('Error al analizar la estructura de la página:', error);
            return null;
        }
    }

    /**
     * Navega a una página específica del sitio después de hacer login
     * @param {string} path - Ruta a la que navegar
     */
    async navigateTo(path) {
        if (!this.loggedIn) {
            await this.login();
        }

        const url = new URL(path, 'https://tasas.cpacf.org.ar/').href;
        logger.info(`Navegando a: ${url}`);

        try {
            await this.page.goto(url, { waitUntil: 'networkidle2' });
            // Verificar si la página existe
            const notFound = await this.page.evaluate(() => {
                return document.title.includes('404') ||
                    document.body.textContent.includes('404 Not Found') ||
                    document.body.textContent.includes('Página no encontrada');
            });

            if (notFound) {
                logger.warn(`La página ${url} no existe (404). Verifique la estructura del sitio.`);
            }
        } catch (error) {
            logger.error(`Error al navegar a ${url}: ${error.message}`);
            throw error;
        }

        return this.page;
    }

    /**
     * Selecciona una tasa específica y navega al formulario de cálculo
     * @param {string|number} rateId - ID de la tasa a seleccionar
     * @returns {Promise<boolean>} - Si la selección fue exitosa
     */
    async selectRate(rateId) {
        if (!this.loggedIn) {
            await this.login();
        }

        try {
            logger.info(`Seleccionando tasa con ID: ${rateId}`);

            // Verificar si estamos en la página principal con el selector de tasas
            const rateSelectExists = await this.page.evaluate(() => {
                return document.querySelector('select[name="rate"]') !== null;
            });

            if (!rateSelectExists) {
                logger.info('No estamos en la página con el selector de tasas, navegando a la página principal...');
                await this.navigateTo('/home');
            }

            // Seleccionar la tasa
            await this.page.select('select[name="rate"]', rateId.toString());

            // Hacer click en el botón SIGUIENTE
            logger.info('Haciendo click en SIGUIENTE para confirmar la selección de tasa...');
            await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const nextButton = links.find(link => link.textContent.includes('SIGUIENTE'));
                if (nextButton) nextButton.click();
                else document.forms[0].submit();
            });

            // Esperar a que la navegación termine
            await this.page.waitForNavigation({ waitUntil: 'networkidle2' });

            // Verificar que estamos en la página de cálculo con el formulario específico
            const isCalculatorPage = await this.page.evaluate(() => {
                return document.querySelector('form[id="dataForm"]') !== null &&
                    document.querySelector('input[name="capital_0"]') !== null &&
                    document.querySelector('input[name="date_from_0"]') !== null &&
                    document.querySelector('input[name="date_to"]') !== null;
            });

            if (!isCalculatorPage) {
                logger.warn('No se pudo acceder a la página de cálculo después de seleccionar la tasa');
                return false;
            }

            // Extraer información adicional sobre el formulario y restricciones
            const formInfo = await this.page.evaluate(() => {
                const minDateFromElem = document.querySelector('#min_date_from');
                const minDateFrom = minDateFromElem ? minDateFromElem.value : '';

                const maxDateToElem = document.querySelector('#max_date_to');
                const maxDateTo = maxDateToElem ? maxDateToElem.value : '';

                const rateIdElem = document.querySelector('input[name="rate_id"]');
                const rateId = rateIdElem ? rateIdElem.value : '';

                // Verificar si hay opciones de capitalización
                const capitalizationSelect = document.querySelector('select[name="capitalization"]');
                let capitalizationOptions = [];

                if (capitalizationSelect) {
                    capitalizationOptions = Array.from(
                        capitalizationSelect.options
                    ).map(option => ({
                        value: option.value,
                        text: option.textContent.trim(),
                        selected: option.selected
                    }));
                }

                // Verificar si requiere fecha de primera capitalización
                const requiresFirstCapitalizationDate =
                    document.querySelector('input[name="date_first_capitalization"]') !== null;

                return {
                    minDateFrom,
                    maxDateTo,
                    rateId,
                    capitalizationOptions,
                    requiresFirstCapitalizationDate,
                    hasCapitalizationSelect: capitalizationSelect !== null
                };
            });

            // Guardar la información del formulario para uso posterior
            this.calculatorFormInfo = formInfo;

            logger.info('Tasa seleccionada correctamente, en página de cálculo');
            logger.info(`Opciones de capitalización disponibles: ${formInfo.hasCapitalizationSelect ? 'Sí' : 'No'}`);

            return true;
        } catch (error) {
            logger.error(`Error al seleccionar la tasa ${rateId}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Guarda los resultados del cálculo en un archivo JSON
     * @param {Object} resultados - Resultados del cálculo
     * @param {string} filePath - Ruta del archivo donde guardar los resultados
     * @returns {Promise<boolean>} - Si se guardó correctamente
     */
    async saveResultsToJSON(resultados, filePath = './server/files/resultados_calculo.json') {
        try {
            // Requerir el módulo fs
            const fs = require('fs');

            // Guardar resultados en el archivo JSON
            fs.writeFileSync(filePath, JSON.stringify(resultados, null, 2));

            logger.info(`Resultados guardados exitosamente en ${filePath}`);
            return true;
        } catch (error) {
            logger.error(`Error al guardar los resultados en JSON: ${error.message}`);
            return false;
        }
    }


    /**
     * Configura los parámetros de cálculo y realiza el cálculo
     * @param {Object} params - Parámetros para el cálculo
     * @param {string|number} params.capital - Capital inicial
     * @param {string} params.date_from_0 - Fecha inicial en formato DD/MM/YYYY
     * @param {string} params.date_to - Fecha final en formato DD/MM/YYYY
     * @param {string} params.capitalization - Tipo de capitalización (ej: "365" para anual)
     * @param {string} params.date_first_capitalization - Fecha de la primera capitalización en formato DD/MM/YYYY
     * @returns {Promise<Object>} - Resultado del cálculo
     */
    async calcular(params) {
        try {
            logger.info('Configurando parámetros de cálculo:', JSON.stringify(params, null, 2));

            // Esperar antes de comenzar para simular comportamiento humano
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 1000));

            // Limpiar los campos antes de completarlos para evitar problemas
            await this.page.evaluate(() => {
                const capitalInput = document.querySelector('input[name="capital_0"]');
                if (capitalInput) capitalInput.value = '';

                const dateFromInput = document.querySelector('input[name="date_from_0"]');
                if (dateFromInput) dateFromInput.value = '';

                const dateToInput = document.querySelector('input[name="date_to"]');
                if (dateToInput) dateToInput.value = '';

                const dateFirstCapitalizationInput = document.querySelector('input[name="date_first_capitalization"]');
                if (dateFirstCapitalizationInput) dateFirstCapitalizationInput.value = '';
            });

            // Completar el formulario con comportamiento más humano
            if (params.capital) {
                // Escribir lentamente, como un humano
                await this.page.click('input[name="capital_0"]');
                await new Promise(resolve => setTimeout(resolve, Math.random() * 400 + 200));

                for (const char of params.capital.toString()) {
                    await this.page.type('input[name="capital_0"]', char, { delay: Math.random() * 100 + 50 });
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                }

                await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400));
            }

            if (params.date_from_0) {
                await this.page.click('input[name="date_from_0"]');
                await new Promise(resolve => setTimeout(resolve, Math.random() * 400 + 200));

                for (const char of params.date_from_0) {
                    await this.page.type('input[name="date_from_0"]', char, { delay: Math.random() * 100 + 50 });
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                }

                await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400));
            }

            if (params.date_to) {
                await this.page.click('input[name="date_to"]');
                await new Promise(resolve => setTimeout(resolve, Math.random() * 400 + 200));

                for (const char of params.date_to) {
                    await this.page.type('input[name="date_to"]', char, { delay: Math.random() * 100 + 50 });
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                }

                await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400));
            }

            // Configurar la capitalización si está disponible
            if (params.capitalization) {
                // Verificar primero si el elemento existe antes de intentar seleccionarlo
                const capitalizationExists = await this.page.evaluate(() => {
                    return document.querySelector('select[name="capitalization"]') !== null;
                });

                if (capitalizationExists) {
                    // Hacer click y esperar un poco antes de seleccionar
                    await this.page.click('select[name="capitalization"]');
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 200));

                    await this.page.select('select[name="capitalization"]', params.capitalization);
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400));
                }
            }

            // Configurar la fecha de primera capitalización si está disponible
            if (params.date_first_capitalization) {
                const dateFirstCapExists = await this.page.evaluate(() => {
                    return document.querySelector('input[name="date_first_capitalization"]') !== null;
                });

                if (dateFirstCapExists) {
                    await this.page.click('input[name="date_first_capitalization"]');
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 400 + 200));

                    for (const char of params.date_first_capitalization) {
                        await this.page.type('input[name="date_first_capitalization"]', char, { delay: Math.random() * 100 + 50 });
                        await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                    }

                    await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400));
                }
            }

            // Esperar un tiempo más antes de hacer clic en el botón de calcular
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 1000));

            // Tomar captura para diagnóstico antes de calcular
            await this.page.screenshot({ path: './server/files/before_calculate.png' });

            // Hacer click en el botón CALCULAR o enviar el formulario
            logger.info('Enviando formulario para calcular...');

            // Detectar y hacer clic en el botón de manera más humana
            const calcularButtonInfo = await this.page.evaluate(() => {
                // Primero buscar un botón o enlace específico con texto CALCULAR
                const calcularButton = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'))
                    .find(el => el.textContent.includes('CALCULAR'));

                if (calcularButton) {
                    const rect = calcularButton.getBoundingClientRect();
                    return {
                        found: true,
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2
                    };
                } else {
                    return { found: false };
                }
            });

            if (calcularButtonInfo.found) {
                // Mover el cursor gradualmente hacia el botón
                await this.page.mouse.move(
                    calcularButtonInfo.x - 40 + Math.random() * 30,
                    calcularButtonInfo.y - 20 + Math.random() * 15,
                    { steps: 10 }
                );

                await new Promise(resolve => setTimeout(resolve, Math.random() * 300 + 200));

                // Mover al centro del botón
                await this.page.mouse.move(
                    calcularButtonInfo.x + Math.random() * 10 - 5,
                    calcularButtonInfo.y + Math.random() * 10 - 5,
                    { steps: 5 }
                );

                await new Promise(resolve => setTimeout(resolve, Math.random() * 200 + 100));

                // Hacer clic
                await this.page.mouse.down();
                await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
                await this.page.mouse.up();
            } else {
                // Si no encuentra el botón, enviar el formulario directamente
                await this.page.evaluate(() => {
                    const form = document.getElementById('dataForm');
                    if (form) form.submit();
                });
            }

            // Usar un timeout más largo para esperar la navegación
            try {
                await this.page.waitForNavigation({
                    waitUntil: 'networkidle2',
                    timeout: 60000 // 60 segundos
                });
            } catch (timeoutError) {
                logger.warn('Timeout esperando navegación después de calcular. Verificando estado actual...');

                // Verificar si hay un error 500 en la página
                const hasServerError = await this.page.evaluate(() => {
                    return document.body.textContent.includes('500') &&
                        document.body.textContent.includes('Server Error');
                });

                if (hasServerError) {
                    logger.error('Se detectó un error 500 del servidor.');

                    // Capturar el estado para diagnóstico
                    await this.page.screenshot({ path: './server/files/server_error.png' });

                    // Intentar navegar hacia atrás y reintentar con un rango de fechas más corto
                    if (params.date_from_0 && params.date_to) {
                        logger.info('Intentando reducir el rango de fechas para evitar el error 500...');

                        await new Promise(resolve => setTimeout(resolve, 5000)); // Espera de 5 segundos

                        try {
                            await this.page.goBack({ timeout: 30000 });
                            await new Promise(resolve => setTimeout(resolve, 3000));

                            // Reducir el rango de fechas a la mitad
                            const dateFrom = new Date(params.date_from_0.split('/').reverse().join('-'));
                            const dateTo = new Date(params.date_to.split('/').reverse().join('-'));

                            const diffTime = Math.abs(dateTo - dateFrom);
                            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                            if (diffDays > 30) {
                                const newDateTo = new Date(dateFrom);
                                newDateTo.setDate(dateFrom.getDate() + Math.min(diffDays / 2, 30));

                                const newDateToStr = `${String(newDateTo.getDate()).padStart(2, '0')}/${String(newDateTo.getMonth() + 1).padStart(2, '0')}/${newDateTo.getFullYear()}`;

                                params.date_to = newDateToStr;

                                logger.info(`Rango reducido: ${params.date_from_0} - ${params.date_to}`);

                                // Reintentar con el rango reducido
                                return await this.calcular(params);
                            }
                        } catch (navError) {
                            logger.error('Error al intentar navegar hacia atrás:', navError);
                        }
                    }

                    throw new Error('Error 500 del servidor al calcular. Intente con un rango de fechas más corto.');
                }
            }

            // Capturar página después de calcular para diagnóstico
            await this.page.screenshot({ path: './server/files/after_calculate.png' });

            // Extraer los resultados generales
            const resultados = await this.extractData(() => {
                // Verificar primero si hay un error 500
                if (document.body.textContent.includes('500') && document.body.textContent.includes('Server Error')) {
                    return {
                        error: 'Error 500 del servidor',
                        pageContent: document.body.textContent.slice(0, 500)
                    };
                }

                // Buscar la tabla de resultados
                const resultTable = document.querySelector('table.resultados') ||
                    document.querySelector('table.table') ||
                    document.querySelector('table');

                if (!resultTable) {
                    // Si no se encuentra tabla, intentar extraer cualquier información relevante
                    const pageContent = document.body.textContent;
                    if (pageContent.includes('Error') || pageContent.includes('error')) {
                        return {
                            error: 'Error en la página de resultados',
                            pageContent: pageContent.slice(0, 500) // Primeros 500 caracteres para diagnóstico
                        };
                    }
                    return { error: 'No se encontró la tabla de resultados' };
                }

                const rows = Array.from(resultTable.querySelectorAll('tr'));
                const result = {};

                rows.forEach(row => {
                    const cells = Array.from(row.querySelectorAll('td, th'));
                    if (cells.length >= 2) {
                        const key = cells[0].textContent.trim().replace(/:/g, '');
                        const value = cells[1].textContent.trim();
                        result[key] = value;
                    }
                });

                // También intentamos extraer el resultado final si existe
                const resultadoFinal = document.querySelector('.resultado-final');
                if (resultadoFinal) {
                    result.resultadoFinal = resultadoFinal.textContent.trim();
                }

                return result;
            });

            // Verificar si hay errores en la respuesta
            if (resultados.error) {
                logger.error(`Error en los resultados: ${resultados.error}`);

                if (resultados.error === 'Error 500 del servidor') {
                    // Si es error 500, intentar nuevamente con rango reducido si es posible
                    if (params.date_from_0 && params.date_to) {
                        logger.info('Intentando reducir el rango de fechas para evitar el error 500...');

                        await new Promise(resolve => setTimeout(resolve, 3000)); // Espera

                        try {
                            await this.page.goBack({ timeout: 30000 });
                            await new Promise(resolve => setTimeout(resolve, 3000));

                            // Reducir el rango de fechas
                            const dateFrom = new Date(params.date_from_0.split('/').reverse().join('-'));
                            const dateTo = new Date(params.date_to.split('/').reverse().join('-'));

                            const diffTime = Math.abs(dateTo - dateFrom);
                            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                            if (diffDays > 30) {
                                const newDateTo = new Date(dateFrom);
                                newDateTo.setDate(dateFrom.getDate() + Math.min(diffDays / 2, 30));

                                const newDateToStr = `${String(newDateTo.getDate()).padStart(2, '0')}/${String(newDateTo.getMonth() + 1).padStart(2, '0')}/${newDateTo.getFullYear()}`;

                                params.date_to = newDateToStr;

                                logger.info(`Rango reducido: ${params.date_from_0} - ${params.date_to}`);

                                // Reintentar con el rango reducido
                                return await this.calcular(params);
                            }
                        } catch (navError) {
                            logger.error('Error al intentar navegar hacia atrás:', navError);
                        }
                    }
                }
            }

            // Usar el extractor unificado para obtener los detalles
            logger.info('Extrayendo detalles con el extractor unificado...');
            const resultadoExtraccion = await this.extractTablaUnificada();

            if (resultadoExtraccion.detalles && Array.isArray(resultadoExtraccion.detalles) && resultadoExtraccion.detalles.length > 0) {
                resultados.detalles = resultadoExtraccion.detalles;
                resultados.modeloTabla = resultadoExtraccion.modelo;
                logger.info(`Extracción exitosa con modelo de tabla ${resultadoExtraccion.modelo}: ${resultadoExtraccion.detalles.length} filas extraídas`);

                // Guardar información de debug si está disponible
                if (resultadoExtraccion.debugInfo) {
                    logger.info('Información de depuración:', resultadoExtraccion.debugInfo);
                }

                return resultados;
            } else {
                // Si el extractor unificado falló, intentar con los extractores antiguos
                logger.warn('El extractor unificado no pudo obtener datos. Intentando con extractores específicos...');

                try {
                    logger.info('Intentando extractor específico CPACF...');
                    const detallesCPACF = await this.extractCPACFDetalle();

                    if (Array.isArray(detallesCPACF) && detallesCPACF.length > 0) {
                        resultados.detalles = detallesCPACF;
                        logger.info(`Extracción exitosa con CPACF: ${detallesCPACF.length} filas extraídas`);
                        return resultados;
                    }
                } catch (extractorSpecificError) {
                    logger.warn('Error en el extractor específico CPACF:', extractorSpecificError);
                }

                try {
                    logger.info('Intentando extractor genérico como fallback final...');
                    const detallesData = await this.extractDetallesTabla();

                    if (Array.isArray(detallesData) && detallesData.length > 0) {
                        resultados.detalles = detallesData;
                        logger.info(`Extracción exitosa con extractor genérico: ${detallesData.length} filas extraídas`);
                        return resultados;
                    }
                } catch (extractorGenericoError) {
                    logger.warn('Error en el extractor genérico:', extractorGenericoError);
                }

                // Si llegamos aquí, todos los extractores fallaron
                logger.error('No se pudieron extraer detalles con ningún método');
                logger.info('Detalles de error de extracción unificada:', resultadoExtraccion);

                // Devolver lo que tengamos, aunque no incluya detalles
                return resultados;
            }
        } catch (error) {
            logger.error(`Error al realizar el cálculo: ${error.message}`);

            // Capturar el estado actual para diagnóstico
            try {
                await this.page.screenshot({ path: './server/files/error_state.png' });
                const html = await this.page.content();
                const fs = require('fs');
                fs.writeFileSync('./server/files/error_page.html', html);
                logger.info('Se capturaron pantallas de diagnóstico del error');
            } catch (captureError) {
                logger.error('Error al capturar diagnósticos:', captureError);
            }

            throw error;
        }
    }

    /**
     * Obtiene la lista de todas las tasas disponibles
     * @returns {Promise<Array>} - Lista de tasas
     */
    async getAvailableRates() {
        if (!this.loggedIn) {
            await this.login();
        }

        try {
            // Verificar si estamos en la página principal con el selector de tasas
            const rateSelectExists = await this.page.evaluate(() => {
                return document.querySelector('select[name="rate"]') !== null;
            });

            if (!rateSelectExists) {
                //console.log('No estamos en la página con el selector de tasas, navegando a la página principal...');
                await this.navigateTo('/home');
            }

            const rates = await this.page.evaluate(() => {
                const select = document.querySelector('select[name="rate"]');
                if (!select) return [];

                return Array.from(select.options)
                    .filter(option => option.value !== '-1') // Excluir la opción "Seleccione la tasa"
                    .map(option => ({
                        id: option.value,
                        name: option.textContent.trim()
                    }));
            });

            //console.log(`Se encontraron ${rates.length} tasas disponibles`);
            return rates;
        } catch (error) {
            //console.error('Error al obtener las tasas disponibles:', error);
            throw error;
        }
    }

    /**
     * Extrae datos de la página actual
     * @param {Function} extractionFn - Función para extraer datos
     * @returns {Promise<any>} - Datos extraídos
     */
    async extractData(extractionFn) {
        if (!this.loggedIn) {
            await this.login();
        }

        return await this.page.evaluate(extractionFn);
    }

    /**
     * Toma una captura de pantalla de la página actual
     * @param {string} path - Ruta donde guardar la captura
     */
    async screenshot(path) {
        if (!this.page) {
            throw new Error('El navegador no está inicializado');
        }
        await this.page.screenshot({ path });
    }


    /**
     * Extrae datos de tablas de tasas de interés, unificando la detección de diferentes modelos de tablas
     * @returns {Promise<Array|Object>} Array de objetos con detalles o objeto con error
     */
    async extractTablaUnificada() {
        return await this.extractData(() => {
            // Array para guardar información de depuración
            const debugInfo = [];

            // Buscar tablas con clases específicas primero (enfoque específico)
            const specificContainers = [
                '.table-detalle-calculos',
                '.detalles',
                '#detalles',
                'table.resultados',
                'table.table-detalle'
            ];

            let tablesFound = [];

            // Intentar primero contenedores específicos
            for (const selector of specificContainers) {
                const containers = document.querySelectorAll(selector);
                if (containers.length > 0) {
                    debugInfo.push(`Encontrado contenedor específico: ${selector} (${containers.length})`);

                    // Si el selector es directo a una tabla
                    if (selector.startsWith('table')) {
                        Array.from(containers).forEach(table => tablesFound.push(table));
                    } else {
                        // Si es un contenedor, buscar tablas dentro
                        Array.from(containers).forEach(container => {
                            const tables = container.querySelectorAll('table');
                            if (tables.length > 0) {
                                debugInfo.push(`- Encontradas ${tables.length} tablas dentro de ${selector}`);
                                Array.from(tables).forEach(table => tablesFound.push(table));
                            }
                        });
                    }
                }
            }

            // Si no se encontraron tablas específicas, buscar todas las tablas
            if (tablesFound.length === 0) {
                debugInfo.push('No se encontraron tablas específicas, buscando todas las tablas');
                tablesFound = Array.from(document.querySelectorAll('table'));
                debugInfo.push(`- Encontradas ${tablesFound.length} tablas generales`);
            }

            // Si no hay tablas, devolver error
            if (tablesFound.length === 0) {
                return {
                    error: 'No se encontraron tablas en la página',
                    debugInfo
                };
            }

            // Procesar cada tabla para detectar su modelo y extraer datos
            for (const table of tablesFound) {
                // Verificar si tiene filas
                const rows = Array.from(table.querySelectorAll('tr'));
                if (rows.length <= 1) {
                    debugInfo.push('Tabla ignorada: menos de 2 filas');
                    continue; // Ignorar tablas sin datos
                }

                // Obtener encabezados
                const headerRow = rows[0];
                const headers = Array.from(headerRow.querySelectorAll('th, td')).map(cell => {
                    return cell.textContent.trim().toLowerCase();
                });

                debugInfo.push(`Analizando tabla con encabezados: ${headers.join(', ')}`);

                // Verificar si es una tabla de detalles buscando palabras clave
                const isDetallesTable = headers.some(h => h.includes('desde')) &&
                    headers.some(h => h.includes('hasta')) &&
                    headers.some(h => h.includes('día')) &&
                    (headers.some(h => h.includes('int')) ||
                        headers.some(h => h.includes('tasa')));

                if (!isDetallesTable) {
                    debugInfo.push('Tabla ignorada: no parece contener detalles de tasas');
                    continue;
                }

                // Detectar modelo de tabla basado en encabezados
                let modelo = 0;

                if (headers.some(h => h.includes('int. mensual')) &&
                    headers.some(h => h.includes('int. diario'))) {
                    modelo = 1; // Modelo 1: % Int. Mensual y % Int. Diario
                    debugInfo.push('Detectado Modelo 1: % Int. Mensual y % Int. Diario');
                } else if (headers.some(h => h.includes('int. anual')) &&
                    headers.some(h => h.includes('int. diario'))) {
                    modelo = 2; // Modelo 2: % Int. Anual y % Int. Diario
                    debugInfo.push('Detectado Modelo 2: % Int. Anual y % Int. Diario');
                } else if (headers.some(h => h.includes('int.')) &&
                    !headers.some(h => h.includes('int. diario'))) {
                    modelo = 3; // Modelo 3: solo % Int. (anual)
                    debugInfo.push('Detectado Modelo 3: solo % Int. (asumido como anual)');
                } else {
                    debugInfo.push('Modelo no reconocido, intentando detección dinámica');
                }

                // Mapear índices de columnas dinámicamente
                const indexMap = {
                    fechaDesde: headers.findIndex(h => h.includes('desde')),
                    fechaHasta: headers.findIndex(h => h.includes('hasta')),
                    dias: headers.findIndex(h => h.includes('día')),
                    capital: headers.findIndex(h => h.includes('capital')),
                    porcentajeAnual: headers.findIndex(h =>
                    (h.includes('int. anual') ||
                        (modelo === 3 && h.includes('int.') && !h.includes('intereses')))),
                    porcentajeMensual: headers.findIndex(h => h.includes('int. mensual')),
                    porcentajeDiario: headers.findIndex(h => h.includes('int. diario')),
                    montoIntereses: headers.findIndex(h =>
                        h.includes('monto') && (h.includes('intereses') || h.includes('int')))
                };

                debugInfo.push(`Mapeo de columnas: ${JSON.stringify(indexMap)}`);

                // Verificar si el mapeo es válido (al menos debe tener desde, hasta y algún tipo de interés)
                const hasRequiredColumns = indexMap.fechaDesde >= 0 &&
                    indexMap.fechaHasta >= 0 &&
                    (indexMap.porcentajeAnual >= 0 ||
                        indexMap.porcentajeMensual >= 0 ||
                        indexMap.porcentajeDiario >= 0);

                if (!hasRequiredColumns) {
                    debugInfo.push('Mapeo inválido: faltan columnas requeridas');
                    continue;
                }

                // Extraer datos de las filas
                const dataRows = rows.slice(1); // Ignorar fila de encabezados
                const detalles = [];

                dataRows.forEach((row, rowIndex) => {
                    const cells = Array.from(row.querySelectorAll('td'));

                    // Verificar que hay suficientes celdas
                    if (cells.length < 3) {
                        debugInfo.push(`Fila ${rowIndex + 1} ignorada: menos de 3 celdas`);
                        return;
                    }

                    // Crear objeto de detalle
                    const detalle = {};

                    // Asignar valores basados en el mapeo
                    if (indexMap.fechaDesde >= 0 && indexMap.fechaDesde < cells.length) {
                        detalle.fecha_desde = cells[indexMap.fechaDesde].textContent.trim();
                    }

                    if (indexMap.fechaHasta >= 0 && indexMap.fechaHasta < cells.length) {
                        detalle.fecha_hasta = cells[indexMap.fechaHasta].textContent.trim();
                    }

                    if (indexMap.dias >= 0 && indexMap.dias < cells.length) {
                        detalle.dias = parseInt(cells[indexMap.dias].textContent.trim().replace(/[^\d]/g, ''), 10) || 0;
                    }

                    if (indexMap.capital >= 0 && indexMap.capital < cells.length) {
                        detalle.capital = cells[indexMap.capital].textContent.trim();
                    }

                    // Procesamiento de porcentajes según el modelo

                    // Modelo 1: Int. Mensual y Diario
                    if (modelo === 1) {
                        if (indexMap.porcentajeMensual >= 0 && indexMap.porcentajeMensual < cells.length) {
                            let porcentajeMensualText = cells[indexMap.porcentajeMensual].textContent.trim();
                            let porcentajeMensualNum = parseFloat(porcentajeMensualText.replace(/[^\d,.]/g, '').replace(',', '.'));

                            if (!isNaN(porcentajeMensualNum)) {
                                detalle.porcentaje_interes_mensual = porcentajeMensualNum;
                                // Calcular anual (mensual * 12)
                                detalle.porcentaje_interes_anual = parseFloat((porcentajeMensualNum * 12).toFixed(6));
                            }
                        }

                        if (indexMap.porcentajeDiario >= 0 && indexMap.porcentajeDiario < cells.length) {
                            let porcentajeDiarioText = cells[indexMap.porcentajeDiario].textContent.trim();
                            let porcentajeDiarioNum = parseFloat(porcentajeDiarioText.replace(/[^\d,.]/g, '').replace(',', '.'));

                            if (!isNaN(porcentajeDiarioNum)) {
                                detalle.porcentaje_interes_diario = porcentajeDiarioNum;
                            }
                        }
                    }
                    // Modelo 2: Int. Anual y Diario
                    else if (modelo === 2) {
                        if (indexMap.porcentajeAnual >= 0 && indexMap.porcentajeAnual < cells.length) {
                            let porcentajeAnualText = cells[indexMap.porcentajeAnual].textContent.trim();
                            let porcentajeAnualNum = parseFloat(porcentajeAnualText.replace(/[^\d,.]/g, '').replace(',', '.'));

                            if (!isNaN(porcentajeAnualNum)) {
                                detalle.porcentaje_interes_anual = porcentajeAnualNum;
                            }
                        }

                        if (indexMap.porcentajeDiario >= 0 && indexMap.porcentajeDiario < cells.length) {
                            let porcentajeDiarioText = cells[indexMap.porcentajeDiario].textContent.trim();
                            let porcentajeDiarioNum = parseFloat(porcentajeDiarioText.replace(/[^\d,.]/g, '').replace(',', '.'));

                            if (!isNaN(porcentajeDiarioNum)) {
                                detalle.porcentaje_interes_diario = porcentajeDiarioNum;
                            }
                        }
                    }
                    // Modelo 3: Solo % Int. (asumido como anual)
                    else if (modelo === 3) {
                        if (indexMap.porcentajeAnual >= 0 && indexMap.porcentajeAnual < cells.length) {
                            let porcentajeText = cells[indexMap.porcentajeAnual].textContent.trim();
                            let porcentajeNum = parseFloat(porcentajeText.replace(/[^\d,.]/g, '').replace(',', '.'));

                            if (!isNaN(porcentajeNum)) {
                                detalle.porcentaje_interes_anual = porcentajeNum;
                                // Calcular diario (anual / 365)
                                detalle.porcentaje_interes_diario = parseFloat((porcentajeNum / 365).toFixed(6));
                            }
                        }
                    }

                    // Asegurarse de que siempre tengamos porcentaje diario calculado
                    if (detalle.porcentaje_interes_anual > 0 && detalle.porcentaje_interes_diario === undefined) {
                        detalle.porcentaje_interes_diario = parseFloat((detalle.porcentaje_interes_anual / 365).toFixed(6));
                    } else if (detalle.porcentaje_interes_diario > 0 && detalle.porcentaje_interes_anual === undefined) {
                        detalle.porcentaje_interes_anual = parseFloat((detalle.porcentaje_interes_diario * 365).toFixed(6));
                    }

                    // Procesar monto de intereses
                    if (indexMap.montoIntereses >= 0 && indexMap.montoIntereses < cells.length) {
                        detalle.monto_intereses = cells[indexMap.montoIntereses].textContent.trim();
                    }

                    // Verificar que tengamos al menos fecha desde, hasta y algún porcentaje
                    if (detalle.fecha_desde && detalle.fecha_hasta &&
                        (detalle.porcentaje_interes_anual > 0 || detalle.porcentaje_interes_diario > 0)) {
                        detalles.push(detalle);
                    } else {
                        debugInfo.push(`Fila ${rowIndex + 1} ignorada: datos incompletos`);
                    }
                });

                // Si encontramos detalles válidos, retornarlos
                if (detalles.length > 0) {
                    debugInfo.push(`Extracción exitosa: ${detalles.length} filas`);
                    return {
                        detalles,
                        modelo,
                        debugInfo
                    };
                }
            }

            // Si llegamos aquí, no pudimos extraer datos de ninguna tabla
            return {
                error: 'No se pudo extraer información de ninguna tabla',
                debugInfo
            };
        });
    }
    /**
     * Extrae detalles de la tabla de resultados con manejo para diferentes estructuras
     * @returns {Array} - Array de objetos con la información detallada
     */
    async extractDetallesTabla() {
        return await this.extractData(() => {
            // Buscar todas las tablas que podrían contener los detalles
            const tables = Array.from(document.querySelectorAll('table'));

            for (const table of tables) {
                // Obtener los encabezados de la tabla
                const headerRow = table.querySelector('tr');
                if (!headerRow) continue;

                const headers = Array.from(headerRow.querySelectorAll('th, td')).map(cell => {
                    // Usar textContent para obtener todo el texto, incluyendo elementos anidados
                    return cell.textContent.trim().toLowerCase();
                });

                // Verificar si es una tabla de detalles buscando palabras clave en los encabezados
                const isDetallesTable = headers.some(h => h.includes('desde') || h.includes('from')) &&
                    headers.some(h => h.includes('hasta') || h.includes('to')) &&
                    (headers.some(h => h.includes('día') || h.includes('days') || h.includes('dias')) ||
                        headers.some(h => h.includes('interés') || h.includes('interest')));

                if (!isDetallesTable) continue;

                //logger.info('Tabla de detalles encontrada. Encabezados:', headers);

                // Identificar índices de columnas importantes basados en los encabezados
                const indexMap = {
                    fechaDesde: headers.findIndex(h => h.includes('desde') || h.includes('from')),
                    fechaHasta: headers.findIndex(h => h.includes('hasta') || h.includes('to')),
                    dias: headers.findIndex(h => h.includes('día') || h.includes('days') || h.includes('dias')),
                    capital: headers.findIndex(h => h.includes('capital') || h.includes('monto')),
                    porcentajeAnual: headers.findIndex(h =>
                        (h.includes('interés') || h.includes('interest')) &&
                        (h.includes('anual') || h.includes('annual'))),
                    porcentajeDiario: headers.findIndex(h =>
                        (h.includes('interés') || h.includes('interest')) &&
                        (h.includes('diario') || h.includes('daily'))),
                    montoIntereses: headers.findIndex(h =>
                        h.includes('monto') && h.includes('interés') ||
                        h.includes('amount') && h.includes('interest'))
                };

                //logger.info('Mapeo de índices de columnas:', indexMap);

                // Obtener todas las filas de datos (excluyendo la fila de encabezado)
                const dataRows = Array.from(table.querySelectorAll('tr')).slice(1);
                const detalles = [];

                dataRows.forEach(row => {
                    const cells = Array.from(row.querySelectorAll('td'));

                    // Verificar que hay suficientes celdas para procesar
                    if (cells.length < 3) return;

                    // Crear objeto de detalle con propiedades dinámicas basadas en los índices encontrados
                    const detalle = {};

                    // Asignar valores basados en los índices mapeados
                    if (indexMap.fechaDesde >= 0 && indexMap.fechaDesde < cells.length) {
                        detalle.fecha_desde = cells[indexMap.fechaDesde].textContent.trim();
                    }

                    if (indexMap.fechaHasta >= 0 && indexMap.fechaHasta < cells.length) {
                        detalle.fecha_hasta = cells[indexMap.fechaHasta].textContent.trim();
                    }

                    if (indexMap.dias >= 0 && indexMap.dias < cells.length) {
                        detalle.dias = parseInt(cells[indexMap.dias].textContent.trim().replace(/[^\d]/g, ''), 10) || 0;
                    }

                    if (indexMap.capital >= 0 && indexMap.capital < cells.length) {
                        detalle.capital = cells[indexMap.capital].textContent.trim();
                    }

                    // Procesar porcentaje anual
                    if (indexMap.porcentajeAnual >= 0 && indexMap.porcentajeAnual < cells.length) {
                        let porcentajeAnualText = cells[indexMap.porcentajeAnual].textContent.trim();
                        let porcentajeAnualNum = parseFloat(porcentajeAnualText.replace(/[^\d,.]/g, '').replace(',', '.'));
                        detalle.porcentaje_interes_anual = isNaN(porcentajeAnualNum) ? 0 : porcentajeAnualNum;
                    }

                    // Procesar porcentaje diario (calcularlo si no existe)
                    if (indexMap.porcentajeDiario >= 0 && indexMap.porcentajeDiario < cells.length) {
                        let porcentajeDiarioText = cells[indexMap.porcentajeDiario].textContent.trim();
                        let porcentajeDiarioNum = parseFloat(porcentajeDiarioText.replace(/[^\d,.]/g, '').replace(',', '.'));
                        detalle.porcentaje_interes_diario = isNaN(porcentajeDiarioNum) ? 0 : porcentajeDiarioNum;
                    } else if (detalle.porcentaje_interes_anual > 0) {
                        // Calcular el interés diario dividiendo el anual por 365 si no existe la columna
                        detalle.porcentaje_interes_diario = parseFloat((detalle.porcentaje_interes_anual / 365).toFixed(6));
                    }

                    // Procesar monto de intereses
                    if (indexMap.montoIntereses >= 0 && indexMap.montoIntereses < cells.length) {
                        detalle.monto_intereses = cells[indexMap.montoIntereses].textContent.trim();
                    }

                    // Verificar si el detalle tiene al menos las propiedades mínimas para ser útil
                    if (detalle.fecha_desde && detalle.fecha_hasta) {
                        detalles.push(detalle);
                    }
                });

                // Si hemos encontrado una tabla válida con detalles, retornarla
                if (detalles.length > 0) {
                    return detalles;
                }
            }

            // Si llegamos aquí, no encontramos una tabla válida
            //console.warn('No se encontró una tabla válida de detalles');
            return { error: 'No se encontró una tabla válida con formato de detalles' };
        });
    }

    /**
 * Función para extraer datos específicamente del formato mostrado en el ejemplo CPACF
 * Esta función maneja el formato específico donde:
 * - Primera columna: Desde (fecha)
 * - Segunda columna: Hasta (fecha)
 * - Tercera columna: Días
 * - Cuarta columna: % Int. (interés anual)
 * - Quinta columna: Monto de intereses
 */
    async extractCPACFDetalle() {
        return await this.extractData(() => {
            // Buscar el contenedor de detalles específico
            const detallesContainer = document.querySelector('.detalles') ||
                document.querySelector('#detalles') ||
                document.querySelector('.table-detalle-calculos');

            if (!detallesContainer) {
                //console.warn('No se encontró el contenedor de detalles específico');

                // Buscar cualquier tabla que pueda contener los datos
                const tables = Array.from(document.querySelectorAll('table'));
                for (const table of tables) {
                    // Verificar los encabezados para identificar la tabla correcta
                    const headerRow = table.querySelector('tr');
                    if (!headerRow) continue;

                    const headers = Array.from(headerRow.querySelectorAll('th, td')).map(th =>
                        th.textContent.trim().toLowerCase());

                    // Si encontramos una tabla con los encabezados correctos
                    if (headers.some(h => h.includes('desde')) &&
                        headers.some(h => h.includes('hasta')) &&
                        headers.some(h => h.includes('día')) &&
                        headers.some(h => h.includes('int'))) {

                        //console.log('Tabla de detalles CPACF encontrada con encabezados:', headers);

                        // Extraer filas de datos
                        const rows = Array.from(table.querySelectorAll('tr')).slice(1); // Ignorar encabezados
                        const detalles = [];

                        rows.forEach(row => {
                            const cells = Array.from(row.querySelectorAll('td'));

                            // Asegurarnos de que tenemos suficientes celdas
                            if (cells.length >= 5) {
                                // Extraer porcentaje de interés (cuarta columna)
                                let porcentajeText = cells[3].textContent.trim();
                                let porcentajeNum = parseFloat(porcentajeText.replace(/[^\d,.]/g, '').replace(',', '.'));

                                if (isNaN(porcentajeNum)) porcentajeNum = 0;

                                const detalle = {
                                    fecha_desde: cells[0].textContent.trim(),
                                    fecha_hasta: cells[1].textContent.trim(),
                                    dias: parseInt(cells[2].textContent.trim(), 10) || 0,
                                    porcentaje_interes_anual: porcentajeNum,
                                    porcentaje_interes_diario: parseFloat((porcentajeNum / 365).toFixed(6)),
                                    monto_intereses: cells[4].textContent.trim()
                                };

                                detalles.push(detalle);
                            }
                        });

                        //console.log(`Se extrajeron ${detalles.length} filas de detalles CPACF`);
                        return detalles;
                    }
                }

                return { error: 'No se encontró la tabla de detalles CPACF' };
            }

            // Si encontramos el contenedor específico, buscar la tabla dentro de él
            const table = detallesContainer.querySelector('table');
            if (!table) {
                return { error: 'Se encontró el contenedor de detalles pero no contiene una tabla' };
            }

            // Extraer filas de datos
            const rows = Array.from(table.querySelectorAll('tr')).slice(1); // Ignorar la fila de encabezados
            const detalles = [];

            rows.forEach(row => {
                const cells = Array.from(row.querySelectorAll('td'));

                // Asegurarnos de que tenemos suficientes celdas
                if (cells.length >= 5) {
                    // Extraer porcentaje de interés (cuarta columna)
                    let porcentajeText = cells[3].textContent.trim();
                    let porcentajeNum = parseFloat(porcentajeText.replace(/[^\d,.]/g, '').replace(',', '.'));

                    if (isNaN(porcentajeNum)) porcentajeNum = 0;

                    const detalle = {
                        fecha_desde: cells[0].textContent.trim(),
                        fecha_hasta: cells[1].textContent.trim(),
                        dias: parseInt(cells[2].textContent.trim(), 10) || 0,
                        porcentaje_interes_anual: porcentajeNum,
                        porcentaje_interes_diario: parseFloat((porcentajeNum / 365).toFixed(6)),
                        monto_intereses: cells[4].textContent.trim()
                    };

                    detalles.push(detalle);
                }
            });

            //console.log(`Se extrajeron ${detalles.length} filas de detalles CPACF`);
            return detalles;
        });
    }


    /**
     * Cierra el navegador y limpia los recursos
     */
    async close() {
        if (this.browser) {
            logger.info('Cerrando navegador...');

            try {
                // 1. Cerrar todas las páginas primero
                if (typeof this.browser.pages === 'function') {
                    try {
                        const pages = await this.browser.pages();
                        if (pages && pages.length > 0) {
                            logger.info(`Cerrando ${pages.length} páginas abiertas...`);
                            await Promise.all(pages.map(page => {
                                if (page && typeof page.close === 'function') {
                                    return page.close().catch(e => logger.warn(`Error al cerrar página: ${e.message}`));
                                }
                                return Promise.resolve();
                            }));
                        }
                    } catch (pagesError) {
                        logger.warn(`Error al obtener páginas: ${pagesError.message}`);
                    }
                }

                // 2. Intentar obtener el PID del proceso
                let pid = null;
                try {
                    if (typeof this.browser.process === 'function') {
                        const process = this.browser.process();
                        if (process && process.pid) {
                            pid = process.pid;
                            logger.info(`PID del navegador: ${pid}`);
                        }
                    }
                } catch (e) {
                    logger.warn(`No se pudo obtener PID: ${e.message}`);
                }

                // 3. Intentar desconectar o cerrar dependiendo de lo disponible
                try {
                    if (typeof this.browser.disconnect === 'function') {
                        await this.browser.disconnect();
                        logger.info('Navegador desconectado correctamente');
                    } else if (typeof this.browser.close === 'function') {
                        await this.browser.close();
                        logger.info('Navegador cerrado correctamente');
                    } else {
                        logger.warn('No se encontraron métodos de cierre o desconexión');
                    }
                } catch (disconnectError) {
                    logger.warn(`Error al cerrar/desconectar: ${disconnectError.message}`);
                }

                // 4. Si tenemos el PID, usar exec para matarlo después
                if (pid) {
                    setTimeout(() => {
                        try {
                            const { exec } = require('child_process');
                            // Usar pkill para matar el proceso y sus hijos
                            exec(`pkill -P ${pid} || true && kill -9 ${pid} || true`, (error) => {
                                if (error) {
                                    logger.warn(`No se pudo matar proceso ${pid}: ${error.message}`);
                                } else {
                                    logger.info(`Proceso ${pid} terminado forzosamente`);
                                }
                            });
                        } catch (execError) {
                            logger.warn(`Error al ejecutar comando kill: ${execError.message}`);
                        }
                    }, 1000);
                } else {
                    // 5. Si no tenemos PID, intentar matarlos todos
                    setTimeout(() => {
                        try {
                            const { exec } = require('child_process');
                            exec(`pkill -f 'chromium.*--remote-debugging-port' || true`, (error) => {
                                if (error && error.code !== 1) {
                                    logger.warn(`Error al limpiar procesos: ${error.message}`);
                                } else {
                                    logger.info('Limpieza de procesos completada');
                                }
                            });
                        } catch (pkillError) {
                            logger.warn(`Error al ejecutar pkill: ${pkillError.message}`);
                        }
                    }, 1000);
                }
            } catch (error) {
                logger.error(`Error general al cerrar navegador: ${error.message}`);
            } finally {
                // Limpiar referencias
                this.browser = null;
                this.page = null;
                this.loggedIn = false;
            }
        }
    }
}



async function main({ tasaId, dni, tomo, folio, screenshot, capital, fechaDesde, fechaHasta, tipoTasa }) {

    const scraper = new CPACFScraper({
        dni: dni,
        tomo: tomo,
        folio: folio,
        tasaId: tasaId
    });

    try {
        // Inicializar el scraper
        await scraper.initialize();

        // Realizar login - esto también analizará la estructura de la página
        await scraper.login();

        // Examinar la página principal después del login

        // Obtener la lista de tasas disponibles
        const tasas = await scraper.getAvailableRates();
        logger.info('Tasas disponibles:');
        tasas.forEach(tasa => {
            logger.info(`- [${tasa.id}] ${tasa.name}`);
        });

        // Buscar la tasa seleccionada en la lista
        const tasaSeleccionada = tasas.find(t => t.id === tasaId) || tasas[0];

        if (tasaSeleccionada) {
            /*             console.log(`Seleccionando tasa: ${tasaSeleccionada.name} (ID: ${tasaSeleccionada.id})`); */

            // Seleccionar la tasa
            await scraper.selectRate(tasaSeleccionada.id);

            // Verificar la información del formulario después de seleccionar la tasa
            const formInfo = scraper.calculatorFormInfo;
            /* console.log('Información del formulario de cálculo:'); */
            if (formInfo) {
                logger.info(`- Fecha mínima permitida: ${formInfo.minDateFrom || 'No especificada'}`);
                logger.info(`- Fecha máxima permitida: ${formInfo.maxDateTo || 'No especificada'}`);
            } else {
                //console.log('- No se pudo obtener información del formulario');
            }

            // Obtener la fecha mínima en formato DD/MM/YYYY para usarla en el cálculo
            const minDateFrom = formInfo && formInfo.minDateFrom ? formInfo.minDateFrom : '2003-11-07';
            const minDateArr = minDateFrom.split('-');
            const fechaMinima = `${minDateArr[2]}/${minDateArr[1]}/${minDateArr[0]}`;

            // Obtener la fecha actual en formato DD/MM/YYYY
            const today = new Date();
            const fechaActual = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

            // Validar la fecha máxima contra formInfo.maxDateTo
            let fechaHastaValidada = fechaHasta;
            if (formInfo && formInfo.maxDateTo) {
                // Convertir formInfo.maxDateTo (YYYY-MM-DD) a objeto Date
                const maxDateArr = formInfo.maxDateTo.split('-');
                const maxDateObj = new Date(maxDateArr[0], maxDateArr[1] - 1, maxDateArr[2]);

                // Convertir fechaHasta (DD/MM/YYYY) a objeto Date
                const fechaHastaArr = fechaHasta.split('/');
                const fechaHastaObj = new Date(fechaHastaArr[2], fechaHastaArr[1] - 1, fechaHastaArr[0]);

                // Si fechaHasta es mayor que la fecha máxima permitida, usar la fecha máxima
                if (fechaHastaObj > maxDateObj) {
                    fechaHastaValidada = `${maxDateArr[2]}/${maxDateArr[1]}/${maxDateArr[0]}`;
                    logger.info(`Fecha hasta ajustada a fecha máxima permitida: ${fechaHastaValidada}`);
                }
            }

            // Configurar los parámetros según los NOMBRES DE CAMPO reales del formulario
            const paramsCalculo = {
                capital: capital,
                date_from_0: fechaDesde, // Usar nombre de campo real
                date_to: fechaHastaValidada,    // Usar la fecha validada
            };

            // Establecer la capitalización solo si hay opciones disponibles
            if (formInfo && formInfo.capitalizationOptions && formInfo.capitalizationOptions.length > 0) {
                paramsCalculo.capitalization = formInfo.capitalizationOptions[0].value;
                //console.log(`Usando opción de capitalización: ${paramsCalculo.capitalization}`);
            } else {
                //console.log('No hay opciones de capitalización disponibles para esta tasa');
            }

            // Si se requiere fecha de primera capitalización, agregarla
            if (formInfo && formInfo.requiresFirstCapitalizationDate) {
                // Calcular una fecha intermedia entre la inicial y final
                const fechaInicialObj = new Date(minDateArr[0], minDateArr[1] - 1, minDateArr[2]);
                const unAnoDespues = new Date(fechaInicialObj);
                unAnoDespues.setFullYear(unAnoDespues.getFullYear() + 1);

                // Formatear como DD/MM/YYYY
                const fechaCapitalizacion = `${String(unAnoDespues.getDate()).padStart(2, '0')}/${String(unAnoDespues.getMonth() + 1).padStart(2, '0')}/${unAnoDespues.getFullYear()}`;

                paramsCalculo.date_first_capitalization = fechaCapitalizacion; // Usar nombre de campo real
                //console.log(`Usando fecha de primera capitalización: ${fechaCapitalizacion}`);
            }

            //console.log('Realizando cálculo con parámetros:', paramsCalculo);

            // Realizar el cálculo (ahora incluye extraer detalles)
            const resultado = await scraper.calcular(paramsCalculo);

            // Verificar si se obtuvieron los detalles
            if (resultado.detalles && Array.isArray(resultado.detalles) && resultado.detalles.length > 0) {
                logger.info('Se obtuvieron los detalles del cálculo:');
                logger.info(`Número de períodos: ${resultado.detalles.length}`);

                // Mostrar un ejemplo de los datos extraídos

                logger.info(`Ejemplo del primer período:\n- Desde: ${resultado.detalles[0].fecha_desde}\n- Hasta: ${resultado.detalles[0].fecha_hasta}\n- % Int. Anual: ${resultado.detalles[0].porcentaje_interes_anual}\n- % Int. Diario: ${resultado.detalles[0].porcentaje_interes_diario}`);

                // Guardar los resultados en un archivo JSON
                const jsonFilePath = `./server/files/resultados_detallados${Date.now()}.json`;
                await scraper.saveResultsToJSON(resultado, jsonFilePath);
                logger.info(`Los detalles del cálculo se han guardado en ${jsonFilePath}`);
                const procesar = await procesarYGuardarTasas(resultado.detalles, { tipoTasa: tipoTasa });
                if (procesar.fechasProcesadas.length > 0) {
                    const actualizacionResult = await actualizarFechasFaltantes(tipoTasa, procesar.fechasProcesadas)
                    logger.info('Resultado de actualización de fechas faltantes:', actualizacionResult.message);
                }
                // Más información de diagnóstico
                logger.info(`Procesamiento completado:\n- Total registros: ${procesar.total}\n- Nuevos creados: ${procesar.creados}\n- Actualizados: ${procesar.actualizados}\n- Errores: ${procesar.errores}
                `);

            } else {
                logger.warn('No se pudieron obtener los detalles del cálculo');
                logger.info('Resultado general del cálculo:');
                logger.info(JSON.stringify(resultado, null, 2));
            }

            // Guardar una captura de pantalla del resultado
            if (screenshot) {
                await scraper.screenshot('resultado.png');
            }
        } else {
            //console.error('No se encontró ninguna tasa disponible');
        }

    } catch (error) {
        logger.error('Error durante el scraping:', error);
    } finally {
        await scraper.close();
        //logger.info('Proceso completado. El navegador sigue abierto para inspección manual.');
    }
};

/**
 * Genera un rango de fechas basado en las fechas faltantes del objeto
 * @param {Object} tasaData - Objeto con información de la tasa y fechasFaltantes
 * @returns {Object} - Objeto con fechaDesde y fechaHasta en formato DD/MM/YYYY
 */
function generarRangoFechas(tasaData) {
    // Verificar que existan fechas faltantes
    if (!tasaData.fechasFaltantes || !tasaData.fechasFaltantes.length) {
        logger.error('No hay fechas faltantes en el objeto proporcionado');
        return null;
    }

    // Ordenar las fechas faltantes (por si acaso no están en orden)
    const fechasOrdenadas = [...tasaData.fechasFaltantes].sort((a, b) => {
        return new Date(a.fecha) - new Date(b.fecha);
    });

    // Obtener la primera y última fecha
    const primeraFecha = fechasOrdenadas[0].fecha;
    const ultimaFecha = fechasOrdenadas[fechasOrdenadas.length - 1].fecha;

    // Si solo hay una fecha o las fechas son iguales, generar un rango más amplio
    if (primeraFecha === ultimaFecha || fechasOrdenadas.length === 1) {
        // Convertir la fecha a objeto moment
        const fechaBase = moment(primeraFecha);

        // Generar un rango que incluya el mes anterior y el siguiente
        const fechaDesdeAmpliada = fechaBase.clone().subtract(1, 'month').format('DD/MM/YYYY');
        const fechaHastaAmpliada = fechaBase.clone().add(1, 'month').format('DD/MM/YYYY');

        return {
            fechaDesde: fechaDesdeAmpliada,
            fechaHasta: fechaHastaAmpliada
        };
    }

    // Para múltiples fechas, usar el rango original
    const fechaDesde = moment(primeraFecha).format('DD/MM/YYYY');
    const fechaHasta = moment(ultimaFecha).format('DD/MM/YYYY');

    return {
        fechaDesde,
        fechaHasta
    };
}


/**
 * Procesa un array de objetos con rangos de fechas y porcentajes de interés
 * y los guarda en la base de datos como documentos individuales por día
 * 
 * @param {Array} detalles - Array de objetos con rangos de fechas y porcentajes
 * @param {Object} options - Opciones adicionales
 * @returns {Promise<Object>} - Resultado del procesamiento
 */
async function procesarYGuardarTasas(detalles, options = {}) {
    //console.log("Detalles", detalles);
    // Resultados del procesamiento
    const result = {
        total: 0,
        creados: 0,
        actualizados: 0,
        errores: 0,
        detalle_errores: [],
        // Añadir array para registrar las fechas procesadas (formato requerido por actualizarFechasFaltantes)
        fechasProcesadas: []
    };

    if (!Array.isArray(detalles) || detalles.length === 0) {
        logger.warn("No hay detalles para procesar");
        return result;
    }

    // Procesar cada objeto de detalle
    for (const detalle of detalles) {
        try {
            // Verificar que tengamos los datos mínimos necesarios
            if (!detalle.fecha_desde || !detalle.fecha_hasta) {
                logger.warn("Detalle sin fechas:", detalle);
                result.errores++;
                result.detalle_errores.push({
                    tipo: "Datos incompletos",
                    detalle: JSON.stringify(detalle)
                });
                continue;
            }

            // Seleccionar el mejor valor de tasa disponible:
            //   1. Diario (es el valor que se almacena directamente en la BD)
            //   2. Mensual derivado a diario (mensual / 30.4167)
            //   3. Anual derivado a diario (anual / 365)
            let valorTasa = null;
            let fuenteValor = null;

            if (detalle.porcentaje_interes_diario != null) {
                valorTasa = detalle.porcentaje_interes_diario;
                fuenteValor = 'diario';
            } else if (detalle.porcentaje_interes_mensual != null) {
                valorTasa = parseFloat((detalle.porcentaje_interes_mensual / 30.4167).toFixed(8));
                fuenteValor = 'mensual→diario';
                logger.info('[procesarYGuardarTasas] ' + options.tipoTasa + ': usando tasa mensual derivada a diaria (' + detalle.porcentaje_interes_mensual + ' → ' + valorTasa + ')');
            } else if (detalle.porcentaje_interes_anual != null) {
                valorTasa = parseFloat((detalle.porcentaje_interes_anual / 365).toFixed(8));
                fuenteValor = 'anual→diario';
                logger.info('[procesarYGuardarTasas] ' + options.tipoTasa + ': usando tasa anual derivada a diaria (' + detalle.porcentaje_interes_anual + ' → ' + valorTasa + ')');
            }

            if (valorTasa == null) {
                logger.warn("Detalle sin valor de tasa (ni diario, ni mensual, ni anual):", detalle);
                result.errores++;
                result.detalle_errores.push({
                    tipo: "Sin valor de tasa",
                    detalle: JSON.stringify(detalle)
                });
                continue;
            }

            // Convertir las fechas desde/hasta a objetos moment
            const fechaDesde = moment(detalle.fecha_desde, "DD/MM/YYYY");
            const fechaHasta = moment(detalle.fecha_hasta, "DD/MM/YYYY");

            // Verificar que las fechas sean válidas
            if (!fechaDesde.isValid() || !fechaHasta.isValid()) {
                logger.warn("Fechas inválidas:", detalle.fecha_desde, detalle.fecha_hasta);
                result.errores++;
                result.detalle_errores.push({
                    tipo: "Fechas inválidas",
                    detalle: JSON.stringify(detalle)
                });
                continue;
            }

            // Crear un array con todas las fechas entre desde y hasta (inclusive)
            const fechas = [];
            const fechaActual = moment(fechaDesde);

            while (fechaActual.isSameOrBefore(fechaHasta, 'day')) {
                fechas.push(moment(fechaActual));
                fechaActual.add(1, 'day');
            }

            // Procesar cada fecha individual en el rango
            for (const fecha of fechas) {
                result.total++;

                // Crear el objeto de datos para guardar
                const tasaData = {
                    fecha: fecha.toDate(),
                    [options.tipoTasa]: valorTasa
                };

                try {
                    // Buscar si ya existe un documento para esta fecha
                    const fechaNormalizada = moment.utc(fecha).startOf('day').toDate();
                    const existingDoc = await Tasas.findOne({ fecha: fechaNormalizada });

                    if (existingDoc) {
                        // Actualizar el documento existente
                        existingDoc[options.tipoTasa] = tasaData[options.tipoTasa];
                        if (!existingDoc.fuentes) existingDoc.fuentes = {};
                        existingDoc.fuentes[options.tipoTasa] = 'Colegio';
                        existingDoc.markModified('fuentes');
                        await existingDoc.save();
                        result.actualizados++;

                        // Añadir fecha al array de fechas procesadas (formato YYYY-MM-DD)
                        result.fechasProcesadas.push({
                            fecha: fecha.format('YYYY-MM-DD')
                        });
                    } else {
                        // Crear un nuevo documento
                        tasaData.fuentes = { [options.tipoTasa]: 'Colegio' };
                        const nuevaTasa = new Tasas(tasaData);
                        await nuevaTasa.save();
                        result.creados++;

                        // Añadir fecha al array de fechas procesadas (formato YYYY-MM-DD)
                        result.fechasProcesadas.push({
                            fecha: fecha.format('YYYY-MM-DD')
                        });
                    }
                } catch (dbError) {
                    // Ignorar errores de MERGED_WITH_EXISTING ya que es un comportamiento esperado
                    if (dbError.message === 'MERGED_WITH_EXISTING') {
                        result.actualizados++;

                        // Añadir fecha al array de fechas procesadas (formato YYYY-MM-DD)
                        result.fechasProcesadas.push({
                            fecha: fecha.format('YYYY-MM-DD')
                        });
                    } else {
                        logger.error(`Error al guardar fecha ${fecha.format('DD/MM/YYYY')}:`, dbError);
                        result.errores++;
                        result.detalle_errores.push({
                            tipo: "Error DB",
                            fecha: fecha.format('DD/MM/YYYY'),
                            error: dbError.message
                        });
                    }
                }
            }
        } catch (error) {
            logger.error("Error procesando detalle:", error);
            result.errores++;
            result.detalle_errores.push({
                tipo: "Error general",
                error: error.message,
                detalle: JSON.stringify(detalle)
            });
        }
    }
    //console.log("Resultado", result)
    return result;
}


/**
 * Busca y actualiza datos faltantes para una tasa específica
 * @param {string} tipoTasa - Tipo de tasa a actualizar
 * @param {string} tasaId - ID de la tasa
 * @param {Object} options - Opciones adicionales
 * @param {string} [options.fechaDesde] - Fecha desde (formato DD/MM/YYYY)
 * @param {string} [options.fechaHasta] - Fecha hasta (formato DD/MM/YYYY)
 * @returns {Promise<void>}
 */
async function findMissingDataColegio(tipoTasa, tasaId, options = {}) {
    logger.info(`Verificación de datos para ${tipoTasa}${options.fechaDesde ? ' con fechas específicas' : ''}`);

    let fechaDesde, fechaHasta;
    // Usar UTC para todas las operaciones de fecha
    const hoy = moment().utc().startOf('day');
    logger.info(`Fecha actual (UTC): ${hoy.format('YYYY-MM-DD')}`);

    // Si se proporcionan fechas específicas, usarlas directamente
    if (options.fechaDesde && options.fechaHasta) {
        logger.info(`Usando fechas específicas: ${options.fechaDesde} - ${options.fechaHasta}`);
        fechaDesde = options.fechaDesde;
        fechaHasta = options.fechaHasta;
        
        // Verificar si las fechas son futuras (convertir a UTC)
        const fechaHastaObj = moment.utc(fechaHasta, 'DD/MM/YYYY');
        if (fechaHastaObj.isAfter(hoy)) {
            logger.info(`No se ejecuta el scraping porque la fecha ${fechaHasta} es una fecha futura (UTC)`);
            return; // No ejecutar para fechas futuras
        }
    }
    // Sino, usar la lógica de verificación de fechas faltantes
    else {
        // Obtener primero la configuración de TasasConfig para verificar si ya hay fechas faltantes
        const config = await TasasConfig.findOne({ tipoTasa });
        
        let hayFechasFaltantesPasadas = false;
        
        // Si hay fechas faltantes en el config, filtrar solo las fechas pasadas
        if (config && config.fechasFaltantes && config.fechasFaltantes.length > 0) {
            logger.info(`Total fechas faltantes en TasasConfig: ${config.fechasFaltantes.length}`);
            
            // Filtrar solo fechas pasadas o de hoy (usando UTC)
            const fechasFaltantesPasadas = config.fechasFaltantes.filter(fecha => {
                // Asegurar que tratamos la fecha como UTC
                const fechaUTC = moment.utc(fecha).startOf('day');
                const esPasadaOHoy = fechaUTC.isSameOrBefore(hoy);
                
                if (!esPasadaOHoy) {
                    logger.info(`Fecha futura encontrada: ${fechaUTC.format('YYYY-MM-DD')} > ${hoy.format('YYYY-MM-DD')}`);
                }
                
                return esPasadaOHoy;
            });
            
            if (fechasFaltantesPasadas.length === 0) {
                logger.info(`Todas las fechas faltantes para ${tipoTasa} son fechas futuras (UTC).`);
                // No salimos, ahora verificaremos si hay que actualizar la fecha actual
            } else {
                hayFechasFaltantesPasadas = true;
                logger.info(`Se encontraron ${fechasFaltantesPasadas.length} fechas faltantes pasadas en TasasConfig para ${tipoTasa}`);
                
                // Usar generarRangoFechas con las fechas faltantes pasadas
                const fechas = generarRangoFechas({
                    fechasFaltantes: fechasFaltantesPasadas.map(fecha => ({
                        fecha,
                        fechaFormateada: moment.utc(fecha).format('YYYY-MM-DD')
                    }))
                });
                
                if (fechas) {
                    fechaDesde = fechas.fechaDesde;
                    fechaHasta = fechas.fechaHasta;
                    
                    // Verificar que fechaHasta no sea posterior a hoy (usando UTC)
                    const fechaHastaObj = moment.utc(fechaHasta, 'DD/MM/YYYY');
                    if (fechaHastaObj.isAfter(hoy)) {
                        // Si la fecha es futura, limitar hasta hoy
                        fechaHasta = hoy.format('DD/MM/YYYY');
                        logger.info(`Fecha hasta ajustada a la fecha actual (UTC): ${fechaHasta}`);
                    }
                } else {
                    logger.warn(`No se pudieron generar fechas desde las fechas faltantes para ${tipoTasa}`);
                    hayFechasFaltantesPasadas = false;
                }
            }
        }
        
        // Si no hay fechas faltantes pasadas en el config, verificar otras condiciones
        if (!hayFechasFaltantesPasadas) {
            // Verificar si necesitamos actualizar hasta la fecha actual
            if (!config) {
                // Si no hay configuración, ejecutar verificarFechasFaltantes
                const verificacion = await verificarFechasFaltantes(tipoTasa);
                
                if (verificacion.diasFaltantes > 0) {
                    // Filtrar solo fechas pasadas (usando UTC)
                    const fechasFaltantesPasadas = verificacion.fechasFaltantes.filter(item => {
                        const fechaUTC = moment.utc(item.fecha).startOf('day');
                        return fechaUTC.isSameOrBefore(hoy);
                    });
                    
                    if (fechasFaltantesPasadas.length === 0) {
                        logger.info(`Todas las fechas faltantes para ${tipoTasa} son fechas futuras (UTC).`);
                        // Continuar para verificar fecha actual
                    } else {
                        // Crear un nuevo objeto de verificación con solo las fechas pasadas
                        const verificacionFiltrada = {
                            ...verificacion,
                            fechasFaltantes: fechasFaltantesPasadas,
                            diasFaltantes: fechasFaltantesPasadas.length
                        };
                        
                        const fechas = generarRangoFechas(verificacionFiltrada);
                        if (fechas) {
                            fechaDesde = fechas.fechaDesde;
                            fechaHasta = fechas.fechaHasta;
                            
                            // Verificar que fechaHasta no sea posterior a hoy (usando UTC)
                            const fechaHastaObj = moment.utc(fechaHasta, 'DD/MM/YYYY');
                            if (fechaHastaObj.isAfter(hoy)) {
                                // Si la fecha es futura, limitar hasta hoy
                                fechaHasta = hoy.format('DD/MM/YYYY');
                                logger.info(`Fecha hasta ajustada a la fecha actual (UTC): ${fechaHasta}`);
                            }
                            hayFechasFaltantesPasadas = true;
                        } else {
                            logger.warn(`No se pudieron generar fechas desde la verificación para ${tipoTasa}`);
                            // Continuar para verificar fecha actual
                        }
                    }
                }
            }
            
            // Si aún no tenemos fechas para procesar, verificar si necesitamos actualizar fecha actual
            if (!hayFechasFaltantesPasadas) {
                // Usar el config que ya obtuvimos o la verificación
                const configFinal = config || await TasasConfig.findOne({ tipoTasa });
                
                if (configFinal) {
                    logger.info(`Verificando si hay fechas posteriores a la última fecha registrada para ${tipoTasa}`);
                    logger.info(`Fecha última en DB (UTC): ${moment.utc(configFinal.fechaUltima).format("YYYY-MM-DD")}`);
                    
                    const currentDate = obtenerFechaActualISO();
                    const fechaActualUTC = moment(currentDate).utc().startOf("day");
                    
                    // Verificar si la fecha última en la DB es futura
                    if (moment.utc(configFinal.fechaUltima).isAfter(hoy)) {
                        logger.info(`La fecha última en la DB (${moment.utc(configFinal.fechaUltima).format("YYYY-MM-DD")}) es futura. No se requiere actualización.`);
                        return; // No actualizar si la fecha última es futura
                    }
                    
                    // Verificar si necesitamos actualizar hasta la fecha actual
                    if (fechaActualUTC.isAfter(moment.utc(configFinal.fechaUltima))) {
                        logger.info(`Hay fechas posteriores que actualizar en rango: ${moment.utc(configFinal.fechaUltima).format('DD/MM/YYYY')} - ${fechaActualUTC.format('DD/MM/YYYY')}`);
                        fechaDesde = moment.utc(configFinal.fechaUltima).format('DD/MM/YYYY');
                        fechaHasta = fechaActualUTC.format('DD/MM/YYYY');
                    } else {
                        logger.info('No se requiere actualización - datos actualizados hasta la fecha actual');
                        return; // No hay actualizaciones necesarias
                    }
                } else {
                    logger.warn(`No se pudo obtener configuración para ${tipoTasa}`);
                    return;
                }
            }
        }
    }

    // Si llegamos aquí, tenemos fechas válidas para actualizar
    if (fechaDesde && fechaHasta) {
        // Una verificación adicional para asegurarnos de no procesar fechas futuras (usando UTC)
        const fechaHastaObj = moment.utc(fechaHasta, 'DD/MM/YYYY');
        if (fechaHastaObj.isAfter(hoy)) {
            logger.info(`No se ejecuta el scraping porque la fecha ${fechaHasta} es una fecha futura (UTC)`);
            return;
        }
        
        logger.info(`Ejecutando scraping para rango: ${fechaDesde} - ${fechaHasta}`);
        const scrapingColegio = await main({
            dni: process.env.DU_01,
            tomo: process.env.TREG_01,
            folio: process.env.FREG_01,
            tasaId: tasaId,
            fechaDesde: fechaDesde,
            fechaHasta: fechaHasta,
            capital: 100000,
            screenshot: false,
            tipoTasa: tipoTasa,
        });
    } else {
        logger.warn(`No se pudieron determinar fechas válidas para la actualización de ${tipoTasa}`);
    }
}


// Exportar clase y función principal
module.exports = { CPACFScraper, main, findMissingDataColegio, rectificarUltimasFechas };
/**
 * Re-fetchea los últimos `dias` días de una tasa desde CPACF y sobreescribe los valores
 * existentes. Sirve para detectar y corregir rectificaciones que CPACF publica con posteridad.
 *
 * @param {string} tipoTasa - Identificador de la tasa (ej. 'tasaPasivaBP')
 * @param {string} rateId   - ID de la tasa en CPACF
 * @param {number} [dias=5] - Cuántos días hacia atrás revisar
 */
async function rectificarUltimasFechas(tipoTasa, rateId, dias = 5) {
    const hoy   = moment.utc().startOf('day');
    const desde = hoy.clone().subtract(dias - 1, 'days');
    const fechaDesde = desde.format('DD/MM/YYYY');
    const fechaHasta = hoy.format('DD/MM/YYYY');

    logger.info(`[rectificar] ${tipoTasa}: verificando últimos ${dias} días (${fechaDesde} → ${fechaHasta})`);

    try {
        await main({
            dni: process.env.DU_01,
            tomo: process.env.TREG_01,
            folio: process.env.FREG_01,
            tasaId: rateId,
            fechaDesde,
            fechaHasta,
            capital: 100000,
            screenshot: false,
            tipoTasa,
        });
        logger.info(`[rectificar] ${tipoTasa}: rectificación completada`);
    } catch (err) {
        logger.error(`[rectificar] ${tipoTasa}: error durante rectificación: ${err.message}`);
        throw err;
    }
}
