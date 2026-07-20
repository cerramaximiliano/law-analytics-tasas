/**
 * Scraper del valor del JUS de la Provincia de Buenos Aires (SCBA).
 * ================================================================
 * La SCBA publica el valor del JUS en una página pública. La estructura no se
 * parece a la del CPACF y por eso el scraper es aparte:
 *
 * - La página viene en latin-1, no en UTF-8. Sin decodificarla bien, los "º" y
 *   los acentos llegan rotos y las fechas no parsean.
 * - Los valores no están tabulados en columnas fecha/monto sino en una frase:
 *   "A partir del 1º de abril de 2026: $ 49.750-". El mes va escrito con
 *   palabras y con "de" opcional ("1º marzo" y "1º de marzo" conviven).
 * - Hay DOS series en columnas paralelas de la misma tabla: el JUS de la Ley
 *   14.967 (el vigente, columna izquierda) y el del decreto-ley 8904/77 (una
 *   escala derogada que se conserva por referencia histórica, columna derecha).
 *   Solo se toma el primero: publicar el 8904 como valor actual sería publicar
 *   una escala que ya no rige.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment');
const logger = require('../../utils/logger');

const FUENTE = {
  url: 'https://www.scba.gov.ar/paginas.asp?id=41320',
  leyMarco: 'Ley N° 14.967',
  descripcion: 'JUS — honorarios profesionales en la Provincia de Buenos Aires'
};

const MESES = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12'
};

/**
 * "A partir del 1º de abril de 2026: $ 49.750-" -> { vigenciaDesde, valor }.
 * El "de" antes del mes y del año es opcional; el mes va en palabra.
 */
function parseFrase(txt) {
  if (!txt) return null;
  const m = txt.match(/1[ºo°]?\s*(?:de\s+)?([a-záéíóú]+)\s+(?:de\s+)?(\d{4})\s*:\s*\$\s*([\d.]+)/i);
  if (!m) return null;

  const mesTxt = m[1]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const mes = MESES[mesTxt];
  if (!mes) return null;

  // El monto es entero, con puntos de miles. Sin decimales en esta fuente.
  const valor = Number(m[3].replace(/\./g, ''));
  if (!isFinite(valor) || valor <= 0) return null;

  const vigenciaDesde = moment.utc(`${m[2]}-${mes}-01`, 'YYYY-MM-DD').toDate();
  return { vigenciaDesde, valor, periodo: `${mesTxt.toUpperCase().slice(0, 3)}-${m[2]}` };
}

/**
 * Descarga la página y devuelve la serie del JUS Ley 14.967, del escalón más
 * nuevo al más viejo.
 */
async function obtenerValores() {
  const { data } = await axios.get(FUENTE.url, {
    timeout: 30000,
    // latin-1: se pide el cuerpo crudo y se decodifica a mano, porque axios por
    // defecto asume UTF-8 y rompería los acentos de las fechas.
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });

  const html = Buffer.from(data).toString('latin1');
  const $ = cheerio.load(html);

  // La tabla del JUS es la que tiene el encabezado de la Ley 14.967 en su
  // primera fila. Buscarla por contenido evita depender de que sea la primera
  // tabla de la página, que puede cambiar si agregan un banner.
  let tabla = null;
  $('table').each((_, t) => {
    if (tabla) return;
    if (/14\.?967/.test($(t).find('tr').first().text())) tabla = t;
  });
  if (!tabla) {
    throw new Error('No se encontró la tabla del JUS Ley 14.967. ¿Cambió la página de la SCBA?');
  }

  const filas = [];
  $(tabla)
    .find('tr')
    .each((_, tr) => {
      // Columna 0 = Ley 14.967 (vigente). Columna 2 = decreto-ley 8904/77
      // (derogado), se ignora a propósito.
      const primeraCelda = $(tr).find('td').first().text();
      const parsed = parseFrase(primeraCelda.replace(/\s+/g, ' ').trim());
      if (parsed) {
        filas.push({
          unidad: 'JUS',
          ambito: 'PBA',
          ...parsed,
          norma: 'Ley N° 14.967',
          leyMarco: FUENTE.leyMarco,
          descripcion: FUENTE.descripcion,
          fuente: FUENTE.url
        });
      }
    });

  if (!filas.length) {
    // Devolver cero en silencio haría que el cron "funcione" sin traer nada.
    throw new Error('No se pudo interpretar ninguna fila del JUS SCBA. ¿Cambió la estructura?');
  }

  filas.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
  logger.info(`jusScba: ${filas.length} valores del JUS Ley 14.967, último ${filas[0].periodo} = $${filas[0].valor}.`);
  return filas;
}

module.exports = { obtenerValores, FUENTE };
