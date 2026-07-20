/**
 * Sincronización de valores arancelarios (UMA, JUS y afines) contra la base.
 * =========================================================================
 * Genérico respecto de la fuente: recibe un scraper que devuelve la serie ya
 * parseada y se encarga del resto —comparar contra lo cargado, avisar de
 * correcciones, upsert idempotente—. Así cada unidad nueva (UMA PJN, JUS PBA,
 * el que venga) es un scraper propio y una línea de cron, sin duplicar esta
 * lógica.
 *
 * NO abre ni cierra la conexión a Mongo: usa la del proceso. Un sync que cierra
 * la conexión compartida al terminar dejaría al resto de los crons sin base.
 * El script CLI que sí necesita conexión propia la agrega por fuera.
 */

'use strict';

const ValorArancelario = require('../../models/valoresArancelarios');
const logger = require('../../utils/logger');

/**
 * @param {Object} opts
 * @param {Function} opts.obtener   Scraper: async () => filas[]. Cada fila trae
 *                                   al menos unidad, ambito, valor, vigenciaDesde.
 * @param {string}   opts.etiqueta  Nombre para los logs. Ej: "UMA PJN".
 * @param {boolean}  [opts.simular=false]  No escribe; solo informa qué haría.
 */
async function sincronizarValores({ obtener, etiqueta, simular = false }) {
  const filas = await obtener();

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
      // cargó mal, o la fuente publicó una corrección. Se registra siempre.
      corregidos++;
      logger.warn(`syncValores[${etiqueta}]: ${f.periodo} cambió de ${previo.valor} a ${f.valor} (${f.norma}).`);
    } else {
      nuevos++;
      logger.info(`syncValores[${etiqueta}]: nuevo ${f.periodo} = ${f.valor} (${f.norma}).`);
    }

    if (!simular) {
      await ValorArancelario.findOneAndUpdate(
        clave,
        { $set: { ...f, estado: true } },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }
  }

  const referencia = filas[0] || {};
  const vigente = referencia.unidad
    ? await ValorArancelario.vigente(referencia.unidad, referencia.ambito)
    : null;

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
    `syncValores[${etiqueta}]: ${resumen.publicados} publicados · ${nuevos} nuevos · ${corregidos} corregidos · vigente ${vigente ? vigente.valor + ' (' + vigente.periodo + ')' : 'ninguno'}${simular ? ' [simulado]' : ''}`
  );

  return resumen;
}

module.exports = { sincronizarValores };
