/**
 * Scraper de valores UMA publicados por el CPACF.
 * ===============================================
 * El CPACF publica la serie histórica de la UMA en una página pública, en una
 * tabla con una fila por resolución. No hace falta login: el scraper de tasas
 * del mismo repo sí lo necesita, pero esto es una noticia abierta.
 *
 * Particularidad que conviene tener presente al leer los datos: la fecha de la
 * resolución NO es la de vigencia. La Res 1718/26 se dicta el 13/07/2026 y fija
 * el valor del período MAY-2026, vigente desde el 01/05/2026. O sea que el
 * valor de un mes se publica dos meses después, y el "último valor publicado"
 * no es el "valor vigente hoy". Por eso se guardan las dos fechas.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment');
const logger = require('../../utils/logger');

const FUENTES = {
  // Ley 27.423 — honorarios de abogados y procuradores en el fuero nacional.
  PJN: {
    url: 'https://www.cpacf.org.ar/noticia/5201/valores-uma-pjn-ley-27423l',
    leyMarco: 'Ley N° 27.423',
    descripcion: 'Unidad de Medida Arancelaria del Poder Judicial de la Nación'
  }
};

const MESES = {
  ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06',
  JUL: '07', AGO: '08', SEP: '09', OCT: '10', NOV: '11', DIC: '12'
};

/**
 * "$ 100.173,00" -> 100173.00
 *
 * No alcanza con borrar los puntos: la tabla trae erratas con punto decimal
 * ("$ 52.510.00"), y borrarlos convertía 52.510 en 5.251.000. Se decide por la
 * longitud de lo que sigue al último separador: dos dígitos son decimales,
 * tres son miles.
 */
function aNumero(txt) {
  const s = String(txt).replace(/[^\d.,]/g, '');
  if (!s) return null;

  const corte = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  let entero = s;
  let decimales = '';
  if (corte >= 0) {
    const cola = s.slice(corte + 1);
    if (cola.length === 2) {
      entero = s.slice(0, corte);
      decimales = cola;
    }
  }
  const n = Number(entero.replace(/[.,]/g, '') + (decimales ? '.' + decimales : ''));
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * Fechas en dos formatos conviven en la misma tabla: "13/07/2026" y "16/12/25".
 * moment con formatos explícitos evita que interprete el año de dos dígitos
 * como 1925.
 */
function aFecha(txt) {
  const t = String(txt).trim();
  const m = moment.utc(t, ['DD/MM/YYYY', 'DD/MM/YY'], true);
  return m.isValid() ? m.startOf('day').toDate() : null;
}

/**
 * "MAY-2026" -> 2026-05-01
 *
 * Se aceptan cuatro letras porque la tabla trae "AGOS-2023" en una fila: los
 * rotulos los escribe una persona y no son uniformes.
 */
function periodoAFecha(txt) {
  const m = String(txt).trim().toUpperCase().match(/^([A-Z]{3,4})[-/](\d{4})$/);
  if (!m) return null;
  const mes = MESES[m[1].slice(0, 3)];
  if (!mes) return null;
  return moment.utc(`${m[2]}-${mes}-01`, 'YYYY-MM-DD').toDate();
}

/**
 * Descarga y parsea la tabla. Devuelve las filas que pudo interpretar por
 * completo; las que no, las descarta avisando. Es a propósito: una fila rota no
 * debería impedir que se carguen las 70 que sí están bien, pero tampoco debería
 * pasar en silencio.
 */
async function obtenerValores(ambito = 'PJN') {
  const fuente = FUENTES[ambito];
  if (!fuente) throw new Error(`No hay fuente definida para el ámbito "${ambito}".`);

  const { data } = await axios.get(fuente.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });

  const $ = cheerio.load(data);
  const filas = [];
  const descartadas = [];

  $('table tr').each((_, tr) => {
    const celdas = $(tr)
      .find('td, th')
      .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean);

    // Fila válida: resolución, fecha de la norma, monto, período, vigencia.
    if (celdas.length < 5) return;

    const [norma, fechaNormaTxt, montoTxt, periodoTxt, vigenciaTxt] = celdas;
    const valor = aNumero(montoTxt);
    // La identidad de un valor es el PERÍODO que cubre, no la fecha desde la
    // que rige: una misma resolución fija dos meses de golpe con la misma
    // fecha de vigencia, así que usarla como clave hacía que un período pisara
    // al otro. La fecha de la columna se guarda aparte, porque a veces no es
    // el primero del mes.
    const vigenciaDesde = periodoAFecha(periodoTxt) || aFecha(vigenciaTxt);

    if (!valor || !vigenciaDesde) {
      // El encabezado y los títulos caen acá; solo se reportan los que
      // parecían datos.
      if (/^Res|^Ac/i.test(norma)) descartadas.push(celdas.join(' | '));
      return;
    }

    filas.push({
      unidad: 'UMA',
      ambito,
      valor,
      vigenciaDesde,
      norma: norma.replace(/\s+/g, ' ').trim(),
      fechaPublicacion: aFecha(fechaNormaTxt),
      vigenciaPublicada: aFecha(vigenciaTxt),
      periodo: periodoTxt.trim(),
      leyMarco: fuente.leyMarco,
      descripcion: fuente.descripcion,
      fuente: fuente.url
    });
  });

  // Un período puede aparecer dos veces cuando una resolucion posterior
  // rectifica a otra: la Ac. 27/2018 rehizo los valores que habia fijado la
  // 13/2018 --enero 2018 paso de $567 a $1.417--. Manda la resolucion mas
  // nueva; quedarse con la primera que aparece publicaria un valor derogado.
  const porPeriodo = new Map();
  for (const f of filas) {
    const clave = f.vigenciaDesde.toISOString().slice(0, 10);
    const previa = porPeriodo.get(clave);
    if (!previa) {
      porPeriodo.set(clave, f);
      continue;
    }
    const gana = (f.fechaPublicacion || 0) > (previa.fechaPublicacion || 0) ? f : previa;
    const pierde = gana === f ? previa : f;
    logger.info(
      `umaCpacf: ${f.periodo} tiene dos resoluciones; se usa ${gana.norma} ($${gana.valor}) y se descarta ${pierde.norma} ($${pierde.valor}).`
    );
    porPeriodo.set(clave, gana);
  }
  const unicas = [...porPeriodo.values()].sort((a, b) => b.vigenciaDesde - a.vigenciaDesde);

  if (descartadas.length) {
    logger.warn(`umaCpacf: ${descartadas.length} fila(s) con formato inesperado: ${descartadas.slice(0, 3).join(' // ')}`);
  }
  if (!unicas.length) {
    // Si la página cambia de estructura, esto es lo que hay que ver: devolver
    // cero en silencio haría que el cron "funcione" sin traer nada.
    throw new Error('No se pudo interpretar ninguna fila. ¿Cambió la estructura de la página del CPACF?');
  }

  return unicas;
}

module.exports = { obtenerValores, FUENTES };
