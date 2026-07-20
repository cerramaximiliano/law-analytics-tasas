/**
 * Scraper del valor del JUS de Neuquén (Poder Judicial de Neuquén).
 * ================================================================
 * Los valores están en texto agrupado por año, donde el AÑO es un encabezado
 * suelto y las fechas de cada valor no lo repiten:
 *
 *   "2026 $94.963,25 a partir del 1 de julio $88.538,87 a partir del 1 de abril
 *    $81.129,33 a partir del 1 de enero (Resolución 11-E del 16 de enero de 2026)
 *    2025 $75.185,19 a partir del 1 de octubre. ..."
 *
 * Por eso no se puede parsear cada valor de forma aislada: hay que recorrer el
 * texto en orden llevando el último año visto. Los montos aparecen con "$"
 * adelante o con "pesos" atrás según el año, y la fecha se escribe "1 de julio",
 * "día 1 de octubre" o "01 de julio" indistintamente.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { parseMonto, fechaDeMesAnio, rotuloPeriodo } = require('./valoresParse');

const FUENTE = {
  url: 'https://www.jusneuquen.gov.ar/valor-jus/',
  leyMarco: 'Ley N° 1.594',
  descripcion: 'JUS — honorarios profesionales en la Provincia de Neuquén'
};

// Un token es o un año-encabezado (2023..2026 solo) o un valor con su mes.
// El monto puede venir como "$94.963,25" o "55.158,52 pesos".
const RE_ANIO = /(?<!\d)(20\d{2})(?!\d)(?!\s*[.,]?\s*\d)/g;
const RE_VALOR = /(?:\$\s*([\d.]+,\d{2})|([\d.]+,\d{2})\s*pesos)\s*a partir del\s*(?:día\s*)?0?1\s*d?e?\s*(?:de\s+)?([a-záéíóú]+)/gi;

async function obtenerValores() {
  const { data } = await axios.get(FUENTE.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });
  const $ = cheerio.load(data);

  const i0 = $('body').text().indexOf('Valores históricos');
  const texto = (i0 >= 0 ? $('body').text().slice(i0) : $('body').text()).replace(/\s+/g, ' ');

  // Se arma una lista de marcadores {pos, anio} y {pos, valor, mes} y se recorre
  // en orden: cada valor toma el año del último encabezado anterior a él.
  const anios = [];
  let a;
  while ((a = RE_ANIO.exec(texto)) !== null) anios.push({ pos: a.index, anio: Number(a[1]) });

  const filas = [];
  const porFecha = new Set();
  let v;
  while ((v = RE_VALOR.exec(texto)) !== null) {
    const valor = parseMonto(v[1] || v[2]);
    const mesTxt = v[3];
    if (!valor) continue;

    // Año = el último encabezado cuya posición es anterior a este valor.
    let anio = null;
    for (const h of anios) {
      if (h.pos < v.index) anio = h.anio;
      else break;
    }
    if (!anio) continue;

    const vigenciaDesde = fechaDeMesAnio(mesTxt, anio);
    if (!vigenciaDesde) continue;

    const k = vigenciaDesde.toISOString().slice(0, 10);
    if (porFecha.has(k)) continue;
    porFecha.add(k);

    filas.push({
      unidad: 'JUS',
      ambito: 'NQN',
      valor,
      vigenciaDesde,
      periodo: rotuloPeriodo(vigenciaDesde),
      norma: FUENTE.leyMarco,
      leyMarco: FUENTE.leyMarco,
      descripcion: FUENTE.descripcion,
      fuente: FUENTE.url
    });
  }

  if (!filas.length) {
    throw new Error('No se pudo interpretar ningún valor del JUS de Neuquén. ¿Cambió el texto de la página?');
  }
  filas.sort((a2, b2) => b2.vigenciaDesde - a2.vigenciaDesde);
  logger.info(`jusNeuquen: ${filas.length} valores, último ${filas[0].periodo} = ${filas[0].valor}.`);
  return filas;
}

module.exports = { obtenerValores, FUENTE };
