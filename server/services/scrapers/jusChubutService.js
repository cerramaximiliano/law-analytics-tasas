/**
 * Scraper del valor del JUS de Chubut (Poder Judicial de Chubut).
 * ==============================================================
 * La página trae una tabla limpia: Período (desde) | Norma | Valor ($). La
 * norma va por fila (una resolución administrativa por período), así que se
 * conserva. Montos con centavos.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { parseMonto, fechaDMY, rotuloPeriodo } = require('./valoresParse');

const FUENTE = {
  url: 'https://www.juschubut.gov.ar/servicios/jus/',
  leyMarco: 'Ley XIII N° 4',
  descripcion: 'JUS — honorarios profesionales en la Provincia de Chubut'
};

async function obtenerValores() {
  const { data } = await axios.get(FUENTE.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });
  const $ = cheerio.load(data);

  const filas = [];
  $('table tr').each((_, tr) => {
    const c = $(tr)
      .find('td')
      .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
      .get();
    if (c.length < 3) return; // encabezado

    const vigenciaDesde = fechaDMY(c[0]);
    const valor = parseMonto(c[2]);
    if (!vigenciaDesde || !valor) return;

    filas.push({
      unidad: 'JUS',
      ambito: 'CHU',
      valor,
      vigenciaDesde,
      periodo: rotuloPeriodo(vigenciaDesde),
      norma: c[1].replace(/\s+/g, ' ').trim() || FUENTE.leyMarco,
      leyMarco: FUENTE.leyMarco,
      descripcion: FUENTE.descripcion,
      fuente: FUENTE.url
    });
  });

  if (!filas.length) {
    throw new Error('No se pudo interpretar la tabla del JUS de Chubut. ¿Cambió la página?');
  }
  filas.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
  logger.info(`jusChubut: ${filas.length} valores, último ${filas[0].periodo} = ${filas[0].valor}.`);
  return filas;
}

module.exports = { obtenerValores, FUENTE };
