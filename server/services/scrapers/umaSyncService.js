/**
 * Sincronización de valores UMA contra la base.
 * =============================================
 * Separado del scraper (umaCpacfService, que solo lee la página) y del script
 * CLI (scripts/syncUmaCpacf.js, que agrega conexión propia y logging a
 * consola). Acá vive la lógica que corre tanto desde el cron como desde la
 * línea de comandos, y por eso NO abre ni cierra la conexión a Mongo: usa la
 * que ya tiene el proceso. Un sync que cierra la conexión compartida al
 * terminar dejaría al resto de los crons sin base.
 */

'use strict';

const ValorArancelario = require('../../models/valoresArancelarios');
const { obtenerValores } = require('./umaCpacfService');
const logger = require('../../utils/logger');

/**
 * Trae los valores publicados y los sincroniza. Idempotente: identifica cada
 * valor por (unidad, ámbito, vigenciaDesde), así que correrlo de más no
 * duplica y correrlo cada día solo agrega el escalón nuevo cuando aparece.
 *
 * @param {Object} opts
 * @param {string} [opts.ambito='PJN']
 * @param {boolean} [opts.simular=false]  No escribe; solo informa qué haría.
 * @returns {Promise<{publicados, nuevos, corregidos, sinCambios, vigente}>}
 */
async function sincronizarUma({ ambito = 'PJN', simular = false } = {}) {
  const filas = await obtenerValores(ambito);

  let nuevos = 0;
  let corregidos = 0;
  let sinCambios = 0;

  for (const f of filas) {
    const clave = { unidad: f.unidad, ambito: f.ambito, vigenciaDesde: f.vigenciaDesde };
    const previo = await ValorArancelario.findOne(clave);

    if (previo && previo.valor === f.valor) {
      sinCambios++;
      continue;
    }

    if (previo) {
      // Un valor que cambia para un período ya cargado no es rutina: o se
      // cargó mal, o el CPACF publicó una corrección. Se registra siempre.
      corregidos++;
      logger.warn(`syncUma: ${f.periodo} cambió de ${previo.valor} a ${f.valor} (${f.norma}).`);
    } else {
      nuevos++;
      logger.info(`syncUma: nuevo ${f.periodo} = ${f.valor} (${f.norma}).`);
    }

    if (!simular) {
      await ValorArancelario.findOneAndUpdate(
        clave,
        { $set: { ...f, estado: true } },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }
  }

  const vigente = await ValorArancelario.vigente('UMA', ambito);

  const resumen = {
    publicados: filas.length,
    nuevos,
    corregidos,
    sinCambios,
    vigente: vigente ? { valor: vigente.valor, periodo: vigente.periodo, norma: vigente.norma } : null
  };

  // El cron loguea siempre un resumen: si un día el scraper deja de traer
  // valores nuevos por meses, el resumen es lo que permite notarlo sin esperar
  // a que alguien pregunte por qué el post salió viejo.
  logger.info(
    `syncUma(${ambito}): ${resumen.publicados} publicados · ${nuevos} nuevos · ${corregidos} corregidos · vigente ${vigente ? vigente.valor + ' (' + vigente.periodo + ')' : 'ninguno'}${simular ? ' [simulado]' : ''}`
  );

  return resumen;
}

module.exports = { sincronizarUma };
