/**
 * Scraper del valor del JUS de Córdoba (Poder Judicial de Córdoba).
 * ================================================================
 * A diferencia del CPACF y la SCBA, la página de Córdoba no trae los valores en
 * el HTML: los carga por AJAX desde un JSON estático. Se va directo a ese JSON,
 * que es más estable que parsear una tabla renderizada por JavaScript.
 *
 * Estructura de cada registro:
 *   { IdTipoLegislacion, periodo: "01/07/2026", JUS: "$46.927,21",
 *     VariacionJus, Valor, VariacionParcial }
 *
 * Dos cosas propias de esta fuente:
 * - IdTipoLegislacion separa dos series: "2" es la vigente (ley 9459, desde
 *   2008) y "1" es un único registro histórico de 1997 con otra escala. Solo se
 *   toma la "2"; mezclar las dos daría un salto de $24 a $46.000 sin sentido.
 * - Los montos traen DECIMALES ("$46.927,21"), a diferencia del CPACF y la
 *   SCBA que publican valores enteros. El parser los conserva.
 */

'use strict';

const axios = require('axios');
const moment = require('moment');
const logger = require('../../utils/logger');

const FUENTE = {
  // El JSON que consume la página pública de "JUS y Unidad Económica".
  url: 'https://www.justiciacordoba.gob.ar/Estatico/justiciaCordoba/data/CalculosJudiciales/JUS.json',
  // La página desde la que se llega, para citar como fuente verificable.
  paginaPublica: 'https://www.justiciacordoba.gob.ar/justiciacordoba/Servicios/JUSyUnidadEconomica/1',
  leyMarco: 'Ley N° 9.459',
  descripcion: 'JUS — honorarios profesionales en la Provincia de Córdoba'
};

// La serie vigente. La "1" es un registro suelto de 1997 con otra escala.
const TIPO_VIGENTE = '2';

/** "$46.927,21" -> 46927.21 (conserva los decimales, que acá existen). */
function aNumero(txt) {
  const s = String(txt).replace(/[^\d.,]/g, '');
  if (!s) return null;
  // Formato es-AR: punto de miles, coma decimal.
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

/** "01/07/2026" -> Date UTC al inicio del día. */
function aFecha(txt) {
  const m = moment.utc(String(txt).trim(), 'DD/MM/YYYY', true);
  return m.isValid() ? m.startOf('day').toDate() : null;
}

/** "MMM-AAAA" a partir de la fecha, para rotular el período como las otras fuentes. */
const MESES_ABR = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
function rotuloPeriodo(fecha) {
  return `${MESES_ABR[fecha.getUTCMonth()]}-${fecha.getUTCFullYear()}`;
}

async function obtenerValores() {
  const { data } = await axios.get(FUENTE.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });

  // El endpoint declara text/plain, así que axios puede devolver string.
  const registros = typeof data === 'string' ? JSON.parse(data) : data;
  if (!Array.isArray(registros)) {
    throw new Error('El JSON del JUS de Córdoba no es un array. ¿Cambió el endpoint?');
  }

  const filas = [];
  for (const r of registros) {
    if (String(r.IdTipoLegislacion) !== TIPO_VIGENTE) continue;

    const valor = aNumero(r.JUS);
    const vigenciaDesde = aFecha(r.periodo);
    if (!valor || !vigenciaDesde) continue;

    filas.push({
      unidad: 'JUS',
      ambito: 'CBA',
      valor,
      vigenciaDesde,
      periodo: rotuloPeriodo(vigenciaDesde),
      // Córdoba no publica un número de acuerdo por período en este JSON; la
      // referencia es la ley que crea el JUS.
      norma: 'Ley N° 9.459',
      leyMarco: FUENTE.leyMarco,
      descripcion: FUENTE.descripcion,
      fuente: FUENTE.paginaPublica
    });
  }

  if (!filas.length) {
    throw new Error('No se pudo interpretar ningún valor del JUS de Córdoba. ¿Cambió la estructura del JSON?');
  }

  filas.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
  logger.info(`jusCordoba: ${filas.length} valores del JUS (ley 9459), último ${filas[0].periodo} = ${filas[0].valor}.`);
  return filas;
}

module.exports = { obtenerValores, FUENTE };
