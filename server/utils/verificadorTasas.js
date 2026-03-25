const moment = require('moment');
const { sendEmail } = require('../services/aws_ses/aws_sesService');
const logger = require('./logger');
const TasasConfig = require('../models/tasasConfig');
/**
 * Verifica que todas las tasas estén actualizadas para la fecha actual y reporta errores de scraping
 * 
 * @param {Object} options - Opciones de configuración
 * @param {Boolean} options.soloTasasActivas - Si es true, solo verifica tasas con activa=true
 * @param {Boolean} options.enviarEmail - Si es true, envía email con resultados
 * @param {Boolean} options.notificarExito - Si es true, envía email incluso cuando todo está actualizado
 * @param {Boolean} options.notificarErrores - Si es true, incluye errores de scraping en el reporte
 * @param {String} options.emailDestinatario - Email del destinatario para las alertas
 * @returns {Object} - Resultados de la verificación
 */
async function verificarTasasActualizadas(options = {}) {
    try {
        const {
            soloTasasActivas = true,
            enviarEmail = false,
            notificarExito = false,
            notificarErrores = true,
            emailDestinatario = null
        } = options;

        logger.info('Iniciando verificación de tasas actualizadas');

        // Configuramos moment para usar la zona horaria local de Argentina 
        // o la del servidor donde se está ejecutando la aplicación
        moment.locale('es');

        // Fecha actual al inicio del día en la zona horaria local
        const fechaActual = moment().startOf('day').toDate();

        // Mostramos la fecha actual para verificar en los logs
        logger.info(`Fecha de verificación: ${moment(fechaActual).format('YYYY-MM-DD')} (local)`);

        // Consultar todas las configuraciones de tasas según el filtro
        // Se excluyen siempre las tasas discontinuadas para no generar falsas alertas
        const filtro = soloTasasActivas
            ? { activa: true, discontinuada: { $ne: true } }
            : { discontinuada: { $ne: true } };
        const tasasConfig = await TasasConfig.find(filtro);
        //console.log(tasasConfig)
        if (!tasasConfig || tasasConfig.length === 0) {
            logger.warn('No se encontraron configuraciones de tasas para verificar');
            return {
                status: 'warning',
                message: 'No se encontraron configuraciones de tasas',
                fechaVerificacion: new Date(),
                resultado: []
            };
        }

        logger.info(`Se encontraron ${tasasConfig.length} configuraciones de tasas para verificar`);

        // Resultados de la verificación
        const resultado = [];
        const tasasDesactualizadas = [];

        // Verificar cada tasa
        for (const config of tasasConfig) {
            // Convertir la fecha de la tasa a inicio del día en zona horaria local
            const fechaUltima = moment(config.fechaUltima).utc(0);
            // Diferencia en días entre la fecha actual y la última actualización
            const diasDesde = moment(fechaActual).diff(moment(fechaUltima), 'days');

            // Una tasa está actualizada si:
            // 1. Su fecha de última actualización es hoy (mismo día), O
            // 2. Su fecha de última actualización es futura (días negativos)
            const estaActualizada =
                moment(fechaUltima).isSameOrAfter(fechaActual, 'day') ||
                diasDesde < 0; // Fecha futura

            // Guardar resultado con información adicional
            const estadoTasa = {
                tipoTasa: config.tipoTasa,
                descripcion: config.descripcion || config.tipoTasa,
                fechaUltima: fechaUltima,
                estaActualizada,
                diasDesdeUltimaActualizacion: diasDesde,
                esFechaFutura: diasDesde < 0,
                ultimaVerificacion: config.ultimaVerificacion,
                activa: config.activa
            };

            resultado.push(estadoTasa);

            // Si no está actualizada y está activa, agregar a la lista de desactualizadas
            if (!estaActualizada && config.activa) {
                tasasDesactualizadas.push(estadoTasa);
                logger.warn(`Tasa desactualizada: ${config.tipoTasa}, última actualización: ${moment(fechaUltima).format('YYYY-MM-DD')}, días desde última actualización: ${diasDesde}`);
            } else if (diasDesde < 0) {
                // Loguear información sobre tasas con fechas futuras
                logger.info(`Tasa con fecha futura: ${config.tipoTasa}, fecha: ${moment(fechaUltima).format('YYYY-MM-DD')}, días en el futuro: ${Math.abs(diasDesde)}`);
            } else if (moment(fechaUltima).isSame(fechaActual, 'day')) {
                // Loguear información sobre tasas actualizadas hoy
                logger.info(`Tasa actualizada: ${config.tipoTasa}, fecha: ${moment(fechaUltima).format('YYYY-MM-DD')}`);
            }
        }

        // Actualizar la fecha de verificación en todas las tasas
        await TasasConfig.updateMany({}, { ultimaVerificacion: new Date() });

        // Determinar estado general
        const todasActualizadas = tasasDesactualizadas.length === 0;
        const status = todasActualizadas ? 'success' : 'warning';
        const message = todasActualizadas
            ? 'Todas las tasas están actualizadas'
            : `Hay ${tasasDesactualizadas.length} tasas desactualizadas`;

        // Obtener errores de scraping si se solicita
        let tasasConErrores = [];
        if (notificarErrores) {
            tasasConErrores = await TasasConfig.obtenerTasasConErrores();
            logger.info(`Se encontraron ${tasasConErrores.length} tasas con errores de scraping no resueltos`);
        }

        // Enviar email según la configuración
        if (enviarEmail && emailDestinatario) {
            const hayErroresScraping = tasasConErrores.length > 0;
            
            // Determinar si se debe enviar email basado en configuración y estado
            const debeEnviarEmail = !todasActualizadas || 
                                  (todasActualizadas && notificarExito) || 
                                  (hayErroresScraping && notificarErrores);
            
            if (debeEnviarEmail) {
                if (todasActualizadas && !hayErroresScraping) {
                    // Todo está bien - enviar email de éxito
                    await enviarEmailExito(emailDestinatario, resultado, fechaActual);
                } else if (!todasActualizadas || hayErroresScraping) {
                    // Hay tasas desactualizadas o errores de scraping - enviar alerta
                    await enviarEmailAlerta(emailDestinatario, tasasDesactualizadas, resultado, fechaActual, tasasConErrores);
                }
            }
        }

        // Registrar resultado en logs
        logger.info(`Verificación de tasas completada. Estado: ${status}. ${message}`);

        // Retornar resultado completo
        return {
            status,
            message,
            fechaVerificacion: new Date(),
            fechaActualVerificacion: fechaActual,
            todasActualizadas,
            totalTasas: resultado.length,
            tasasDesactualizadas: tasasDesactualizadas.length,
            tasasConErrores: tasasConErrores.length,
            hayErroresScraping: tasasConErrores.length > 0,
            resultado
        };
    } catch (error) {
        logger.error(`Error al verificar tasas actualizadas: ${error.message}`);
        throw error;
    }
}

/**
 * Envía un email de alerta con las tasas desactualizadas
 * usando la función de envío de correos personalizada
 * 
 * @param {String} destinatario - Email del destinatario
 * @param {Array} tasasDesactualizadas - Lista de tasas desactualizadas
 * @param {Array} todasLasTasas - Lista completa de tasas
 * @param {Date} fechaActual - Fecha actual de la verificación
 * @param {Array} tasasConErrores - Lista de tasas con errores de scraping
 */
async function enviarEmailAlerta(destinatario, tasasDesactualizadas, todasLasTasas, fechaActual, tasasConErrores = []) {
    try {
        // Crear tabla HTML con las tasas desactualizadas
        let tablaTasasDesactualizadas = `
        <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
          <tr style="background-color: #f2f2f2;">
            <th style="text-align: left; padding: 8px;">Tipo de Tasa</th>
            <th style="text-align: left; padding: 8px;">Descripción</th>
            <th style="text-align: center; padding: 8px;">Última Actualización</th>
            <th style="text-align: center; padding: 8px;">Días sin actualizar</th>
          </tr>
      `;

        for (const tasa of tasasDesactualizadas) {
            tablaTasasDesactualizadas += `
          <tr>
            <td style="padding: 8px;">${tasa.tipoTasa}</td>
            <td style="padding: 8px;">${tasa.descripcion}</td>
            <td style="text-align: center; padding: 8px;">${moment(tasa.fechaUltima).format('YYYY-MM-DD')}</td>
            <td style="text-align: center; padding: 8px; ${tasa.diasDesdeUltimaActualizacion > 2 ? 'color: red; font-weight: bold;' : ''}">${tasa.diasDesdeUltimaActualizacion}</td>
          </tr>
        `;
        }

        tablaTasasDesactualizadas += '</table>';

        // Crear resumen de todas las tasas
        let resumenTasas = `
        <h3>Resumen de todas las tasas</h3>
        <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
          <tr style="background-color: #f2f2f2;">
            <th style="text-align: left; padding: 8px;">Tipo de Tasa</th>
            <th style="text-align: center; padding: 8px;">Estado</th>
            <th style="text-align: center; padding: 8px;">Última Actualización</th>
            <th style="text-align: center; padding: 8px;">Días</th>
          </tr>
      `;

        for (const tasa of todasLasTasas) {
            let estadoTexto = tasa.estaActualizada ? 'Actualizada' : 'Desactualizada';
            let estadoColor = tasa.estaActualizada ? 'green' : 'red';

            // Para fechas futuras, mostrar un estado especial
            if (tasa.esFechaFutura) {
                estadoTexto = 'Fecha Futura';
                estadoColor = 'blue';
            }

            resumenTasas += `
          <tr>
            <td style="padding: 8px;">${tasa.tipoTasa}</td>
            <td style="text-align: center; padding: 8px; color: ${estadoColor}; font-weight: ${tasa.estaActualizada ? 'normal' : 'bold'}">${estadoTexto}</td>
            <td style="text-align: center; padding: 8px;">${moment(tasa.fechaUltima).format('YYYY-MM-DD')}</td>
            <td style="text-align: center; padding: 8px;">${tasa.esFechaFutura ? `+${Math.abs(tasa.diasDesdeUltimaActualizacion)}` : tasa.diasDesdeUltimaActualizacion}</td>
          </tr>
        `;
        }

        resumenTasas += '</table>';

        // Obtener las fechas faltantes para cada tasa
        const tasasConfigPromises = todasLasTasas.map(tasa => 
            TasasConfig.findOne({ tipoTasa: tasa.tipoTasa })
        );
        const tasasConfig = await Promise.all(tasasConfigPromises);
        
        // Crear tabla de fechas faltantes
        let tablaFechasFaltantes = `
        <h3>Fechas Faltantes por Tasa</h3>
        <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
          <tr style="background-color: #f2f2f2;">
            <th style="text-align: left; padding: 8px;">Tipo de Tasa</th>
            <th style="text-align: left; padding: 8px;">Fechas Faltantes</th>
          </tr>
        `;

        for (let i = 0; i < todasLasTasas.length; i++) {
            const tasa = todasLasTasas[i];
            const config = tasasConfig[i];
            
            // Formatear las fechas faltantes
            let fechasFaltantesHtml = 'Ninguna';
            if (config && config.fechasFaltantes && config.fechasFaltantes.length > 0) {
                const fechasFormateadas = config.fechasFaltantes
                    .sort((a, b) => new Date(a) - new Date(b))
                    .map(fecha => moment(fecha).format('YYYY-MM-DD'))
                    .join(', ');
                fechasFaltantesHtml = fechasFormateadas;
            }
            
            tablaFechasFaltantes += `
            <tr>
              <td style="padding: 8px;">${tasa.tipoTasa}</td>
              <td style="padding: 8px; ${(config && config.fechasFaltantes && config.fechasFaltantes.length > 0) ? 'color: #d9534f;' : ''}">${fechasFaltantesHtml}</td>
            </tr>
            `;
        }
        
        tablaFechasFaltantes += '</table>';

        // Crear tabla de errores de scraping
        let tablaErroresScraping = '';
        if (tasasConErrores && tasasConErrores.length > 0) {
            tablaErroresScraping = `
            <h3>Errores de Scraping Detectados</h3>
            <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
              <tr style="background-color: #f2f2f2;">
                <th style="text-align: left; padding: 8px;">Tipo de Tasa</th>
                <th style="text-align: left; padding: 8px;">Tarea</th>
                <th style="text-align: left; padding: 8px;">Error</th>
                <th style="text-align: center; padding: 8px;">Fecha</th>
                <th style="text-align: center; padding: 8px;">Intentos</th>
              </tr>
            `;

            for (const tasaConfig of tasasConErrores) {
                // Obtener solo errores no resueltos
                const erroresNoResueltos = tasaConfig.erroresScraping.filter(err => !err.resuelto);
                
                for (const error of erroresNoResueltos) {
                    tablaErroresScraping += `
                    <tr>
                      <td style="padding: 8px; vertical-align: top;">${tasaConfig.tipoTasa}</td>
                      <td style="padding: 8px; vertical-align: top;">${error.taskId}</td>
                      <td style="padding: 8px; vertical-align: top;">
                        <strong>${error.mensaje}</strong>
                        ${error.detalleError ? `<br><small>${error.detalleError}</small>` : ''}
                      </td>
                      <td style="text-align: center; padding: 8px; vertical-align: top;">${moment(error.fecha).format('YYYY-MM-DD HH:mm')}</td>
                      <td style="text-align: center; padding: 8px; vertical-align: top;">${error.intentos}</td>
                    </tr>
                    `;
                }
            }
            
            tablaErroresScraping += '</table>';
        }

        // Agregar alerta de errores de scraping
        const alertaErroresScraping = tasasConErrores && tasasConErrores.length > 0 ? 
            `<div style="background-color: #f8d7da; padding: 10px; border-left: 4px solid #dc3545; margin: 20px 0;">
               <p><strong>⚠️ ATENCIÓN:</strong> Se han detectado <strong>${tasasConErrores.length}</strong> ${tasasConErrores.length === 1 ? 'tasa' : 'tasas'} con errores de scraping. 
               Estos errores pueden estar impidiendo la actualización correcta de los datos.</p>
             </div>` : '';

        // Contenido del email
        const tituloEmail = tasasDesactualizadas.length > 0 ? 
            'Alerta de Tasas Desactualizadas' : 
            'Alerta de Errores de Scraping';
            
        const asunto = tasasDesactualizadas.length > 0 ? 
            `[ALERTA] Tasas Desactualizadas - ${moment(fechaActual).format('YYYY-MM-DD')}` : 
            `[ALERTA] Errores de Scraping - ${moment(fechaActual).format('YYYY-MM-DD')}`;
            
        const htmlBody = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            h2 { color: #d9534f; }
            h3 { color: #333; margin-top: 20px; }
            table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
            th { background-color: #f2f2f2; text-align: left; padding: 8px; }
            td { padding: 8px; border: 1px solid #ddd; }
            .note { background-color: #f8f9fa; padding: 10px; border-left: 4px solid #5bc0de; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h2>${tituloEmail}</h2>
          
          ${tasasDesactualizadas.length > 0 ? 
            `<p>Se han detectado <strong>${tasasDesactualizadas.length}</strong> tasas que no están actualizadas a la fecha actual (${moment(fechaActual).format('YYYY-MM-DD')}).</p>
            
            <h3>Tasas Desactualizadas</h3>
            ${tablaTasasDesactualizadas}` : ''}
          
          ${alertaErroresScraping}
          
          ${resumenTasas}
          
          ${tablaFechasFaltantes}
          
          ${tablaErroresScraping}
          
          <div class="note">
            <p><strong>Nota:</strong> Solo se consideran actualizadas las tasas con fecha de hoy (${moment(fechaActual).format('YYYY-MM-DD')}) o fechas futuras. Las tasas con fechas futuras se muestran con los días en positivo (+).</p>
          </div>
          
          <p>Este es un mensaje automático del sistema de verificación de tasas.</p>
        </body>
        </html>
      `;

        // Versión texto plano del email para clientes que no soportan HTML
        let textBody = '';
        
        if (tasasDesactualizadas.length > 0) {
            textBody = `
        ALERTA DE TASAS DESACTUALIZADAS
        
        Se han detectado ${tasasDesactualizadas.length} tasas que no están actualizadas a la fecha actual (${moment(fechaActual).format('YYYY-MM-DD')}).
        `;
        } else {
            textBody = `
        ALERTA DE ERRORES DE SCRAPING
        `;
        }
        
        if (tasasConErrores && tasasConErrores.length > 0) {
            textBody += `
        ⚠️ ATENCIÓN: Se han detectado ${tasasConErrores.length} ${tasasConErrores.length === 1 ? 'tasa' : 'tasas'} con errores de scraping.
        Estos errores pueden estar impidiendo la actualización correcta de los datos.
        
        Resumen de errores:
        `;
            
            for (const tasaConfig of tasasConErrores) {
                const erroresNoResueltos = tasaConfig.erroresScraping.filter(err => !err.resuelto);
                
                for (const error of erroresNoResueltos) {
                    textBody += `
        - Tasa: ${tasaConfig.tipoTasa}, Tarea: ${error.taskId}
          Error: ${error.mensaje}
          Fecha: ${moment(error.fecha).format('YYYY-MM-DD HH:mm')}
        `;
                }
            }
        }
        
        textBody += `
        Nota: Solo se consideran actualizadas las tasas con fecha de hoy o fechas futuras.
        
        Este es un mensaje automático del sistema de verificación de tasas.
      `;

        // Enviar email usando la función proporcionada
        await sendEmail(
            destinatario,
            asunto,
            htmlBody,
            textBody,
            [] // Sin adjuntos
        );

        logger.info(`Email de alerta enviado a ${destinatario}`);
        return true;
    } catch (error) {
        logger.error(`Error al enviar email de alerta: ${error.message}`);
        return false;
    }
}

/**
 * Envía un email de éxito cuando todas las tasas están actualizadas
 * 
 * @param {String} destinatario - Email del destinatario
 * @param {Array} tasas - Lista completa de tasas
 * @param {Date} fechaActual - Fecha actual de la verificación
 */
async function enviarEmailExito(destinatario, tasas, fechaActual) {
    try {
        // Crear resumen de todas las tasas
        let tablaTasas = `
        <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
          <tr style="background-color: #f2f2f2;">
            <th style="text-align: left; padding: 8px;">Tipo de Tasa</th>
            <th style="text-align: center; padding: 8px;">Estado</th>
            <th style="text-align: center; padding: 8px;">Última Actualización</th>
            <th style="text-align: center; padding: 8px;">Días</th>
          </tr>
      `;

        for (const tasa of tasas) {
            let estadoTexto = 'Actualizada';
            let estadoColor = 'green';

            // Para fechas futuras, mostrar un estado especial
            if (tasa.esFechaFutura) {
                estadoTexto = 'Fecha Futura';
                estadoColor = 'blue';
            }

            // Calcular el valor de días a mostrar (0 para actualizadas hoy, días positivos para futuras)
            const diasMostrar = tasa.esFechaFutura ? `+${Math.abs(tasa.diasDesdeUltimaActualizacion)}` : '0';

            tablaTasas += `
          <tr>
            <td style="padding: 8px;">${tasa.tipoTasa}</td>
            <td style="text-align: center; padding: 8px; color: ${estadoColor};">${estadoTexto}</td>
            <td style="text-align: center; padding: 8px;">${moment(tasa.fechaUltima).format('YYYY-MM-DD')}</td>
            <td style="text-align: center; padding: 8px;">${diasMostrar}</td>
          </tr>
        `;
        }

        tablaTasas += '</table>';

        // Obtener las fechas faltantes para cada tasa
        const tasasConfigPromises = tasas.map(tasa => 
            TasasConfig.findOne({ tipoTasa: tasa.tipoTasa })
        );
        const tasasConfig = await Promise.all(tasasConfigPromises);
        
        // Crear tabla de fechas faltantes
        let tablaFechasFaltantes = `
        <h3>Fechas Faltantes por Tasa</h3>
        <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
          <tr style="background-color: #f2f2f2;">
            <th style="text-align: left; padding: 8px;">Tipo de Tasa</th>
            <th style="text-align: left; padding: 8px;">Fechas Faltantes</th>
          </tr>
        `;

        let hayFechasFaltantes = false;
        for (let i = 0; i < tasas.length; i++) {
            const tasa = tasas[i];
            const config = tasasConfig[i];
            
            // Formatear las fechas faltantes
            let fechasFaltantesHtml = 'Ninguna';
            if (config && config.fechasFaltantes && config.fechasFaltantes.length > 0) {
                hayFechasFaltantes = true;
                const fechasFormateadas = config.fechasFaltantes
                    .sort((a, b) => new Date(a) - new Date(b))
                    .map(fecha => moment(fecha).format('YYYY-MM-DD'))
                    .join(', ');
                fechasFaltantesHtml = fechasFormateadas;
            }
            
            tablaFechasFaltantes += `
            <tr>
              <td style="padding: 8px;">${tasa.tipoTasa}</td>
              <td style="padding: 8px; ${(config && config.fechasFaltantes && config.fechasFaltantes.length > 0) ? 'color: #d9534f;' : ''}">${fechasFaltantesHtml}</td>
            </tr>
            `;
        }
        
        tablaFechasFaltantes += '</table>';

        // Contenido del email
        const asunto = `[ÉXITO] Todas las Tasas Actualizadas - ${moment(fechaActual).format('YYYY-MM-DD')}`;
        const htmlBody = `
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            h2 { color: #5cb85c; }
            h3 { color: #333; margin-top: 20px; }
            table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
            th { background-color: #f2f2f2; text-align: left; padding: 8px; }
            td { padding: 8px; border: 1px solid #ddd; }
            .note { background-color: #f8f9fa; padding: 10px; border-left: 4px solid #5bc0de; margin: 20px 0; }
            .warning { background-color: #fff8e1; padding: 10px; border-left: 4px solid #ffc107; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h2>Todas las Tasas Actualizadas</h2>
          <p>Verificación completada: <strong>Todas las tasas están actualizadas</strong> a la fecha actual (${moment(fechaActual).format('YYYY-MM-DD')}).</p>
          
          <h3>Resumen de Tasas</h3>
          ${tablaTasas}
          
          ${tablaFechasFaltantes}
          
          ${hayFechasFaltantes ? `
          <div class="warning">
            <p><strong>Advertencia:</strong> A pesar de que todas las tasas están actualizadas para la fecha actual, 
            existen fechas faltantes en el historial. Estas fechas deberían ser verificadas y completadas cuando sea posible.</p>
          </div>
          ` : ''}
          
          <div class="note">
            <p><strong>Nota:</strong> Solo se consideran actualizadas las tasas con fecha de hoy (${moment(fechaActual).format('YYYY-MM-DD')}) o fechas futuras. Las tasas con fechas futuras se muestran con los días en positivo (+).</p>
          </div>
          
          <p>Este es un mensaje automático del sistema de verificación de tasas.</p>
        </body>
        </html>
      `;

        // Versión texto plano del email para clientes que no soportan HTML
        const textBody = `
        ÉXITO: TODAS LAS TASAS ACTUALIZADAS
        
        Verificación completada: Todas las tasas están actualizadas a la fecha actual (${moment(fechaActual).format('YYYY-MM-DD')}).
        
        ${hayFechasFaltantes ? 'ADVERTENCIA: A pesar de que todas las tasas están actualizadas para la fecha actual, existen fechas faltantes en el historial.\n' : ''}
        
        Este es un mensaje automático del sistema de verificación de tasas.
      `;

        // Enviar email usando la función proporcionada
        await sendEmail(
            destinatario,
            asunto,
            htmlBody,
            textBody,
            [] // Sin adjuntos
        );

        logger.info(`Email de éxito enviado a ${destinatario}`);
        return true;
    } catch (error) {
        logger.error(`Error al enviar email de éxito: ${error.message}`);
        return false;
    }
}

/**
 * Programa la verificación periódica de tasas actualizadas
 * @param {Object} cronManager - Instancia del administrador de tareas cron
 * @param {Object} options - Opciones de configuración
 */
function programarVerificacionTasas(cronManager, options = {}) {
    const {
        cronExpression = '0 9 * * *',  // Por defecto a las 9:00 AM
        taskId = 'verificacion-tasas-actualizadas',
        soloTasasActivas = true,
        enviarEmail = true,
        notificarExito = false,
        notificarErrores = true,
        emailDestinatario = 'soporte@lawanalytics.app'
    } = options;

    cronManager.scheduleTask(
        taskId,
        cronExpression,
        () => verificarTasasActualizadas({
            soloTasasActivas,
            enviarEmail,
            notificarExito,
            notificarErrores,
            emailDestinatario
        }),
        'Verificación de tasas actualizadas y errores de scraping'
    );

    logger.info(`Verificación de tasas programada con expresión cron: ${cronExpression}`);
}

module.exports = {
    verificarTasasActualizadas,
    programarVerificacionTasas
};