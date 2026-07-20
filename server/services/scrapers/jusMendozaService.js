/**
 * Scraper de los valores del JUS de Mendoza (Poder Judicial de Mendoza).
 * =====================================================================
 * Mendoza publica DOS valores distintos, en dos tablas:
 *
 *   1. "JUS Competencia por cuantía" — el que fija los montos de competencia de
 *      cada fuero. Cambia una vez al año: "desde 01/01/2026 hasta el 31/12/2026".
 *   2. "JUS Honorarios Profesionales" — el equivalente al JUS de honorarios de
 *      las demás provincias. Cambia varias veces al año: "desde 19/06/2026",
 *      "desde 28/05/2026 al 18/06/2026".
 *
 * Se capturan los dos, con ámbitos distintos (MZA y MZA-CUANTIA), para no
 * mezclar dos escalas que no son comparables. Las tablas se identifican por su
 * encabezado, no por su orden, por si la página las reordena.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { parseMonto, fechaDMY, rotuloPeriodo } = require('./valoresParse');

const FUENTE = {
  url: 'https://jusmendoza.gob.ar/tasas-judiciales/',
  leyMarco: 'Ley N° 9.131',
  descripcion: {
    honorarios: 'JUS honorarios — Provincia de Mendoza',
    cuantia: 'JUS competencia por cuantía — Provincia de Mendoza'
  }
};

/** "desde 01/01/2026 hasta el 31/12/2026" / "desde 19/06/2026" -> primera fecha. */
function vigenciaDe(txt) {
  const m = String(txt).match(/desde\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  return m ? fechaDMY(m[1]) : null;
}

async function obtenerValores() {
  const { data } = await axios.get(FUENTE.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });
  const $ = cheerio.load(data);

  const filas = [];
  const porClave = new Set();

  $('table').each((_, tab) => {
    const encabezado = $(tab).find('tr').first().text().toLowerCase();
    const esHonorarios = /honorario/.test(encabezado);
    const ambito = esHonorarios ? 'MZA' : 'MZA-CUANTIA';
    const descripcion = esHonorarios ? FUENTE.descripcion.honorarios : FUENTE.descripcion.cuantia;

    $(tab)
      .find('tr')
      .each((__, tr) => {
        const c = $(tr)
          .find('td')
          .map((k, td) => $(td).text().replace(/\s+/g, ' ').trim())
          .get();
        if (c.length < 2) return;

        const vigenciaDesde = vigenciaDe(c[0]);
        const valor = parseMonto(c[1]);
        if (!vigenciaDesde || !valor) return;

        const clave = `${ambito}|${vigenciaDesde.toISOString().slice(0, 10)}`;
        if (porClave.has(clave)) return;
        porClave.add(clave);

        filas.push({
          unidad: 'JUS',
          ambito,
          valor,
          vigenciaDesde,
          periodo: rotuloPeriodo(vigenciaDesde),
          norma: FUENTE.leyMarco,
          leyMarco: FUENTE.leyMarco,
          descripcion,
          fuente: FUENTE.url
        });
      });
  });

  if (!filas.length) {
    throw new Error('No se pudieron interpretar los valores del JUS de Mendoza. ¿Cambió la página?');
  }
  filas.sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);
  const hon = filas.filter((f) => f.ambito === 'MZA');
  const cua = filas.filter((f) => f.ambito === 'MZA-CUANTIA');
  logger.info(
    `jusMendoza: ${hon.length} honorarios (último ${hon[0] && hon[0].valor}) · ${cua.length} cuantía (último ${cua[0] && cua[0].valor}).`
  );
  return filas;
}

module.exports = { obtenerValores, FUENTE };
