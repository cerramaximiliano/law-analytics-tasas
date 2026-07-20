/**
 * Configuración de los cron jobs para el sistema de tasas
 * 
 * Organizado por tipo de tasa y operación para facilitar modificaciones
 */

const cronConfig = {
    // Configuración de horarios para tareas BNA - Tasa Activa
    bna: {
        tasaActiva: {
            scraping: '0 7,9,11,13,15,21 * * *',       // Scraping directo de BNA
            consejo: '0 22 * * *',                      // Scraping desde Consejo
            busquedaFechas: '5 7 * * *'                // Búsqueda de fechas faltantes
        },
        tasaPasiva: {
            scraping: '15 7,9,11,13,15,21 * * *',       // Scraping directo de BNA
            consejo: '5 22 * * *',                      // Scraping desde Consejo
            busquedaFechas: '10 7 * * *'               // Búsqueda de fechas faltantes
        }
    },

    // Configuración de horarios para tareas BCRA
    bcra: {
        tasaPasiva: {
            scraping: '15 7,9,11,13,15,21 * * *',       // Obtener último dato API BCRA
            busquedaFechas: '20 7 * * *'               // Búsqueda de fechas faltantes
        },
        cer: {
            scraping: '25 7,9,11,13,15,21 * * *',       // Obtener último dato API BCRA - CER
            busquedaFechas: '30 7 * * *'               // Búsqueda de fechas faltantes
        },
        icl: {
            scraping: '35 7,9,11,13,15,21 * * *',                   // Obtener último dato API BCRA - ICL
            busquedaFechas: '40 7 * * *'              // Búsqueda de fechas faltantes
        },
        tasaPasiva27802: {
            scraping: '40 7,9,11,13,15,21 * * *',       // Obtener último dato API BCRA - Tasa Pasiva Ley 27.802 art.55(a)
            busquedaFechas: '45 7 * * *'                // Búsqueda de fechas faltantes
        }
    },

    // Configuración de horarios para tareas Colegio
    // Búsqueda de fechas faltantes
    colegio: {
        tasaActivaCNAT2658: {
            busquedaFechas: '47 7,18,21 * * *'
        },
        tasaActivaCNAT2764: {
            busquedaFechas: '49 7,18,21 * * *'
        },
        tasaActivaBNA: {
            busquedaFechas: '51 7,18,21 * * *'

        },
        tasaActivaTnaBNA: {
            busquedaFechas: '53 7,18,21 * * *'
        },
        tasaPasivaBNA: {
            busquedaFechas: '55 8,10,12 * * *'
        },
        // Banco Provincia (solo CPACF, sin scraper nativo)
        tasaPasivaBP: {
            busquedaFechas: '57 7,18,21 * * *',
            rectificacion:  '0 8 * * *'
        },
        tasaActivaBPDolares: {
            busquedaFechas: '59 7,18,21 * * *',
            rectificacion:  '5 8 * * *'
        },
        tasaPasivaBPDolares: {
            busquedaFechas: '1 8,19,22 * * *',
            rectificacion:  '10 8 * * *'
        }
    },

    // Relleno global de gaps vía CPACF (ejecuta todas las tasas con fechas faltantes)
    cpacfGapFiller: {
        diario: '0 3 * * *'  // 3:00 AM diario, fuera del horario de scraping normal
    },

    manager_files: {
        cleanup: '0 0 * * *'
    },
    // Configuración para verificación de actualizaciones
    verificacion: {
        // Verificación después del ciclo matutino
        matutina: '0 9 * * *',     // A las 9:00 AM, después de todas las tareas de la mañana

        // Verificación después de cada ciclo de actualización
        ciclica: '55 7,9,11,13,15,21 * * *',  // 5 minutos después del último scraping del ciclo

        // Verificación diaria completa
        diaria: '0 23 * * *'      // A las 11:00 PM, reporte diario completo
    },

    syncStats: {
        diaria: '0 4 * * *'
    },

    generateAnalysis: {
        generateAllUsersAnalysis:
            { diaria: '0 5 * * *' }
    },

    // Auditoría de cobertura de la colección `datosprevisionales`.
    // Se programa entre el 28 y el 31 a las 22:00; el servicio internamente
    // verifica si hoy es el último día real del mes (mañana = 1) y solo
    // ejecuta el reporte en ese caso.
    auditDatosPrevisionales: {
        ultimoDiaDelMes: '0 22 28-31 * *'
    },

    // Sincronización de valores UMA (Ley 27.423) desde la tabla pública del
    // CPACF. Dos corridas de lunes a viernes: el CPACF publica una vez por mes
    // sin día fijo, así que se chequea seguido para agarrar la resolución nueva
    // el mismo día. Es idempotente: si no hay nada nuevo, no escribe.
    uma: {
        cpacfPjn: '0 11,15 * * 1-5',
        cpacfCaba: '2 11,15 * * 1-5'
    },

    // Sincronización del valor del JUS de la Provincia de Buenos Aires (SCBA).
    // Mismo criterio que UMA: dos corridas de lunes a viernes, decaladas 5
    // minutos para no pegarle a las dos fuentes en el mismo minuto.
    jus: {
        scbaPba: '5 11,15 * * 1-5',
        cordoba: '7 11,15 * * 1-5'
    }
};

module.exports = cronConfig;