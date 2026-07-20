/**
 * Helpers de parseo compartidos por los scrapers de valores arancelarios.
 * =======================================================================
 * Cada provincia publica el valor con un formato distinto —tabla, líneas de
 * texto, JSON, montos con o sin centavos, meses en palabra o en número— pero
 * las piezas a interpretar se repiten. Estas funciones concentran esas piezas
 * para que cada scraper solo se ocupe de cómo está dispuesta SU página.
 */

'use strict';

const moment = require('moment');

const MESES = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12'
};

const MESES_ABR = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

/**
 * Monto argentino a número, conservando centavos.
 * "$ 136.317,62" -> 136317.62 · "$ 58.465" -> 58465
 * Decide por lo que sigue al último separador: dos dígitos son centavos, tres
 * son miles. Así no rompe con las erratas de punto decimal ("52.510.00") ni
 * con los montos sin centavos.
 */
function parseMonto(txt) {
  const s = String(txt).replace(/[^\d.,]/g, '');
  if (!s) return null;

  const corte = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  let entero = s;
  let decimales = '';
  if (corte >= 0 && s.length - corte - 1 === 2) {
    entero = s.slice(0, corte);
    decimales = s.slice(corte + 1);
  }
  const n = Number(entero.replace(/[.,]/g, '') + (decimales ? '.' + decimales : ''));
  return isFinite(n) && n > 0 ? n : null;
}

/** Nombre de mes (con o sin acento/variantes) a "01".."12", o null. */
function mesANumero(txt) {
  const clave = String(txt)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  return MESES[clave] || null;
}

/** Fecha desde año + nombre de mes (día 1). null si el mes no se reconoce. */
function fechaDeMesAnio(mesTxt, anio) {
  const mes = mesANumero(mesTxt);
  if (!mes) return null;
  return moment.utc(`${anio}-${mes}-01`, 'YYYY-MM-DD').toDate();
}

/** "01/07/2026" (o "1/7/26") a Date UTC al inicio del día, o null. */
function fechaDMY(txt) {
  const m = moment.utc(String(txt).trim(), ['DD/MM/YYYY', 'D/M/YYYY', 'DD/MM/YY', 'D/M/YY'], true);
  return m.isValid() ? m.startOf('day').toDate() : null;
}

/** "MMM-AAAA" a partir de una fecha, como rotulan las otras fuentes. */
function rotuloPeriodo(fecha) {
  return `${MESES_ABR[fecha.getUTCMonth()]}-${fecha.getUTCFullYear()}`;
}

module.exports = { MESES, MESES_ABR, parseMonto, mesANumero, fechaDeMesAnio, fechaDMY, rotuloPeriodo };
