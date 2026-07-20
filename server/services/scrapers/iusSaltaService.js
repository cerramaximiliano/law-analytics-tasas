/**
 * Scraper del valor del IUS de Salta (Poder Judicial de Salta).
 * ============================================================
 * Salta llama a la unidad "IUS", no "JUS" (Ley 8035), y así se conserva. Los
 * valores están en varias tablas "Mes | Valor IUS", una por año, con el mes
 * abreviado ("Julio/26") y el monto seguido del importe en letras, que se
 * descarta. Montos enteros, sin centavos.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment');
const logger = require('../../utils/logger');
const { parseMonto, mesANumero } = require('./valoresParse');

const FUENTE = {
  url: 'https://www.justiciasalta.gov.ar/es/honorarios-abogados',
  leyMarco: 'Ley Provincial N° 8.035',
  descripcion: 'IUS — honorarios profesionales en la Provincia de Salta'
};

/** "Julio/26" -> Date(2026-07-01). Año de dos dígitos: 20xx. */
function periodoAFecha(txt) {
  const m = String(txt).trim().match(/^([a-záéíóú]+)\s*\/\s*(\d{2,4})$/i);
  if (!m) return null;
  const mes = mesANumero(m[1]);
  if (!mes) return null;
  const anio = m[2].length === 2 ? `20${m[2]}` : m[2];
  return moment.utc(`${anio}-${mes}-01`, 'YYYY-MM-DD').toDate();
}

async function obtenerValores() {
  const { data } = await axios.get(FUENTE.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });
  const $ = cheerio.load(data);

  const porFecha = new Map();
  $('table tr').each((_, tr) => {
    const c = $(tr)
      .find('td')
      .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
      .get();
    if (c.length < 2) return;

    const fecha = periodoAFecha(c[0]);
    const valor = parseMonto(c[1]);
    if (!fecha || !valor) return;

    // El mismo mes puede repetirse entre tablas; se conserva una sola vez.
    const k = fecha.toISOString().slice(0, 10);
    if (!porFecha.has(k)) {
      porFecha.set(k, {
        unidad: 'IUS',
        ambito: 'SAL',
        valor,
        vigenciaDesde: fecha,
        periodo: `${['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'][fecha.getUTCMonth()]}-${fecha.getUTCFullYear()}`,
        norma: FUENTE.leyMarco,
        leyMarco: FUENTE.leyMarco,
        descripcion: FUENTE.descripcion,
        fuente: FUENTE.url
      });
    }
  });

  const filas = [...porFecha.values()];
  if (!filas.length) {
    throw new Error('No se pudo interpretar la tabla del IUS de Salta. ¿Cambió la página?');
  }
  filas.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
  logger.info(`iusSalta: ${filas.length} valores, último ${filas[0].periodo} = ${filas[0].valor}.`);
  return filas;
}

module.exports = { obtenerValores, FUENTE };
