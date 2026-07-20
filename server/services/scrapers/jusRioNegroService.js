/**
 * Scraper del valor del JUS de Río Negro (Colegio de la Abogacía de Río Negro).
 * ============================================================================
 * Esta página es la más irregular de todas y por eso el scraper es defensivo:
 *
 * - El valor VIGENTE no está en la tabla sino en un card aparte, bajo el texto
 *   "Valor JUS y SELLADOS $ 87.107,00 - Resolución Conjunta Nº 640/26 STJ y
 *    192/26 PG desde el 1 de julio del 2026". Ese card es el que hay que mirar
 *   para las actualizaciones futuras; la tabla sirve para la carga histórica.
 * - En la tabla, una misma celda "Valor $" puede traer DOS valores pegados sin
 *   separador: "A partir del 01/03/2026: $ 77.875,00A partir del 01/04/2026:
 *    $ 79.588,00". Se extraen todos los pares fecha+monto de la celda, no uno.
 * - Hay erratas de doble signo: "A partir del 01/02/2026 $ $75.446,00".
 *
 * Cada valor se asocia a la resolución de su fila (columna "Resolución"), salvo
 * el del card, que trae la suya en el mismo texto.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { parseMonto, fechaDMY, rotuloPeriodo } = require('./valoresParse');

const FUENTE = {
  url: 'https://colegioabogaciarn.org.ar/jus-y-sellados/valores-jus/',
  leyMarco: 'Ley N° 2.212',
  descripcion: 'JUS — honorarios profesionales en la Provincia de Río Negro'
};

// "A partir del 01/03/2026: $ 77.875,00" — el ":" y los "$" sobran a veces.
const RE_VALOR = /A partir del\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*:?\s*\$?\s*\$?\s*([\d.]+,\d{2})/gi;

function armarFila(fechaTxt, montoTxt, norma) {
  const vigenciaDesde = fechaDMY(fechaTxt);
  const valor = parseMonto(montoTxt);
  if (!vigenciaDesde || !valor) return null;
  return {
    unidad: 'JUS',
    ambito: 'RN',
    valor,
    vigenciaDesde,
    periodo: rotuloPeriodo(vigenciaDesde),
    norma: (norma || FUENTE.leyMarco).replace(/\s+/g, ' ').trim(),
    leyMarco: FUENTE.leyMarco,
    descripcion: FUENTE.descripcion,
    fuente: FUENTE.url
  };
}

async function obtenerValores() {
  const { data } = await axios.get(FUENTE.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });
  const $ = cheerio.load(data);

  const porFecha = new Map();
  const guardar = (fila) => {
    if (!fila) return;
    const k = fila.vigenciaDesde.toISOString().slice(0, 10);
    // El card (valor vigente) tiene prioridad sobre la tabla si coinciden.
    if (!porFecha.has(k)) porFecha.set(k, fila);
  };

  // 1. Card del valor vigente. Se procesa primero para que gane ante empates.
  const cuerpo = $('body').text().replace(/\s+/g, ' ');
  const mCard = cuerpo.match(
    /Valor JUS y SELLADOS\s*\$?\s*([\d.]+,\d{2})\s*-?\s*([^]*?)\s*desde el\s*(\d+)\s*d?e?\s*([a-záéíóú]+)\s*del?\s*(\d{4})/i
  );
  if (mCard) {
    const { fechaDeMesAnio } = require('./valoresParse');
    const vig = fechaDeMesAnio(mCard[4], mCard[5]);
    const valor = parseMonto(mCard[1]);
    if (vig && valor) {
      guardar({
        unidad: 'JUS',
        ambito: 'RN',
        valor,
        vigenciaDesde: vig,
        periodo: rotuloPeriodo(vig),
        norma: mCard[2].replace(/\s+/g, ' ').trim().slice(0, 90) || FUENTE.leyMarco,
        leyMarco: FUENTE.leyMarco,
        descripcion: FUENTE.descripcion,
        fuente: FUENTE.url
      });
    }
  }

  // 2. Tabla histórica. Cada fila: Fecha | Valor $ (puede traer varios) | Resolución.
  $('table tr').each((_, tr) => {
    const celdas = $(tr).find('td');
    if (celdas.length < 2) return;
    const valorCol = $(celdas[1]).text();
    const norma = celdas.length >= 3 ? $(celdas[2]).text() : '';

    let m;
    RE_VALOR.lastIndex = 0;
    while ((m = RE_VALOR.exec(valorCol)) !== null) {
      guardar(armarFila(m[1], m[2], norma));
    }
  });

  const filas = [...porFecha.values()];
  if (!filas.length) {
    throw new Error('No se pudo interpretar ningún valor del JUS de Río Negro. ¿Cambió la página?');
  }
  filas.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
  logger.info(`jusRioNegro: ${filas.length} valores, último ${filas[0].periodo} = ${filas[0].valor}.`);
  return filas;
}

module.exports = { obtenerValores, FUENTE };
