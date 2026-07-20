/**
 * Scraper del valor de la Unidad JUS de Santa Fe.
 * ===============================================
 * Los valores NO están en una tabla sino en líneas de texto corrido:
 *   "$136.317,62 a partir del 1 de abril de 2026 – Resolución de Secretaría de
 *    Gobierno de fecha 10.6.2026."
 *   "Montos precedentes: $132.863,18 a partir del 1 de marzo de 2026 – Acuerdo
 *    del 26.5.2026, Acta N° 18, p. 9. ..."
 *
 * Cada valor trae su propia norma (el acuerdo o la resolución que lo fija), así
 * que se captura por valor. Se recorre el texto plano con una expresión que
 * ubica cada "$monto a partir del <fecha en palabras>" y toma como norma lo que
 * va desde el guión hasta el siguiente "$".
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { parseMonto, fechaDeMesAnio, rotuloPeriodo } = require('./valoresParse');

const FUENTE = {
  url: 'https://www.justiciasantafe.gov.ar/index.php/unidad_jus/unidad-jus-ley-12851/',
  leyMarco: 'Ley N° 12.851',
  descripcion: 'Unidad JUS — honorarios profesionales en la Provincia de Santa Fe'
};

// "$136.317,62 a partir del 1 de abril de 2026 – <norma hasta el próximo $ o fin>"
const RE = /\$\s*([\d.]+,\d{2})\s*a partir del\s*\d+\s*d?e?\s*([a-záéíóú]+)\s*de\s*(\d{4})\s*[–-]\s*([^$]*)/gi;

async function obtenerValores() {
  const { data } = await axios.get(FUENTE.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });
  const $ = cheerio.load(data);
  // Texto plano de todo el cuerpo: el bloque de valores no está en un contenedor
  // propio identificable, así que se busca en el texto completo.
  const texto = $('body').text().replace(/\s+/g, ' ');

  const filas = [];
  let m;
  while ((m = RE.exec(texto)) !== null) {
    const valor = parseMonto(m[1]);
    const vigenciaDesde = fechaDeMesAnio(m[2], m[3]);
    if (!valor || !vigenciaDesde) continue;

    // La norma es el texto tras el guión, hasta el próximo monto. Se recorta en
    // el primer punto seguido de espacio y mayúscula/cierre para no arrastrar
    // la oración siguiente, y se limita el largo.
    let norma = m[4].replace(/\s+/g, ' ').trim().replace(/[.,;]\s*$/, '');
    norma = norma.replace(/\bMontos precedentes:.*$/i, '').trim();
    if (norma.length > 90) norma = norma.slice(0, 90).trim();

    filas.push({
      unidad: 'JUS',
      ambito: 'SFE',
      valor,
      vigenciaDesde,
      periodo: rotuloPeriodo(vigenciaDesde),
      norma: norma || FUENTE.leyMarco,
      leyMarco: FUENTE.leyMarco,
      descripcion: FUENTE.descripcion,
      fuente: FUENTE.url
    });
  }

  if (!filas.length) {
    throw new Error('No se pudo interpretar ningún valor del JUS de Santa Fe. ¿Cambió el texto de la página?');
  }
  // Dedup por período: el valor vigente aparece una vez como "actual" y podría
  // repetirse en "precedentes"; se queda con el primero (el actual).
  const vistos = new Set();
  const unicas = filas.filter((f) => {
    const k = f.vigenciaDesde.toISOString().slice(0, 10);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  unicas.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
  logger.info(`jusSantaFe: ${unicas.length} valores, último ${unicas[0].periodo} = ${unicas[0].valor}.`);
  return unicas;
}

module.exports = { obtenerValores, FUENTE };
