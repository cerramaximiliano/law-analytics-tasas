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
  },
  // Ley 5.134 — honorarios profesionales en el fuero de la Ciudad de Buenos
  // Aires. Misma estructura de tabla que PJN, otra ley y otra autoridad (la
  // fija la Presidencia del Consejo de la Magistratura de la CABA).
  CABA: {
    url: 'https://www.cpacf.org.ar/noticia/5196/uma-pj-caba',
    leyMarco: 'Ley N° 5.134',
    descripcion: 'Unidad de Medida Arancelaria del Poder Judicial de la CABA'
  }
};

const MESES = {
  ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06',
  JUL: '07', AGO: '08', SEP: '09', OCT: '10', NOV: '11', DIC: '12'
};

const MESES_LARGOS = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12'
};

const ETIQUETA_MES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

// Solo se baja el PDF de normas publicadas hace poco: los duplicados históricos
// (Ac. 27/2018 y compañía) ya están saldados y verificarlos en cada corrida
// sería descargar los mismos PDFs tres veces por día para nada.
const VENTANA_VERIFICACION_MS = 180 * 24 * 60 * 60 * 1000;

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

function periodoDesdeFecha(fecha) {
  const m = moment.utc(fecha);
  return `${ETIQUETA_MES[m.month()]}-${m.year()}`;
}

/**
 * Descarga el PDF de una resolución y extrae monto y vigencia de su texto.
 * La resolución es la fuente de verdad: la tabla del CPACF la carga una persona
 * y aparece con montos vacíos o períodos mal rotulados (la Res 1930/26 entró
 * con el monto en blanco y etiquetada JUN-2026 cuando su PDF fija JUL-2026).
 *
 * Texto típico: "... equivale a la suma de PESOS CIENTO CUATRO MIL DOSCIENTOS
 * VEINTE ($104.220) a partir del primero de julio de 2026".
 *
 * Devuelve { valor, vigenciaDesde } o null si el texto no matchea (PDF
 * escaneado sin capa de texto, redacción distinta, etc.) — en ese caso el
 * caller decide si se queda con lo que dice la tabla.
 */
async function extraerDatosResolucionPdf(url) {
  const pdfParse = require('pdf-parse');
  const { data } = await axios.get(url, {
    timeout: 30000,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'law-analytics-bot/1.0 (+https://lawanalytics.app)' }
  });
  const texto = (await pdfParse(data)).text.replace(/\s+/g, ' ');

  const montoMatch = texto.match(/\(\s*\$\s*([\d.,]+)\s*\)/);
  const valor = montoMatch ? aNumero(montoMatch[1]) : null;

  const vigMatch = texto
    .toLowerCase()
    .match(/a partir del\s+(?:d[ií]a\s+)?(primero|\d{1,2})[°º]?\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/);
  let vigenciaDesde = null;
  if (vigMatch) {
    const dia = vigMatch[1] === 'primero' ? '01' : vigMatch[1].padStart(2, '0');
    const mes = MESES_LARGOS[vigMatch[2]];
    if (mes) {
      const f = moment.utc(`${vigMatch[3]}-${mes}-${dia}`, 'YYYY-MM-DD', true);
      if (f.isValid()) vigenciaDesde = f.startOf('day').toDate();
    }
  }

  if (!valor || !vigenciaDesde) return null;
  return { valor, vigenciaDesde };
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
  const pendientesPdf = [];

  $('table tr').each((_, tr) => {
    // Sin filter(Boolean): una celda vacía (monto en blanco) debe conservar su
    // posición — filtrarla corría el resto de las columnas y la fila entera se
    // salteaba en silencio por el largo.
    const celdas = $(tr)
      .find('td, th')
      .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
      .get();

    // Fila válida: resolución, fecha de la norma, monto, período, vigencia.
    if (celdas.filter(Boolean).length < 2 || celdas.length < 5) return;

    const [norma, fechaNormaTxt, montoTxt, periodoTxt, vigenciaTxt] = celdas;
    let normaUrl = $(tr).find('a[href]').first().attr('href') || null;
    if (normaUrl && normaUrl.startsWith('/')) normaUrl = 'https://www.cpacf.org.ar' + normaUrl;
    const valor = aNumero(montoTxt);
    // La identidad de un valor es el PERÍODO que cubre, no la fecha desde la
    // que rige: una misma resolución fija dos meses de golpe con la misma
    // fecha de vigencia, así que usarla como clave hacía que un período pisara
    // al otro. La fecha de la columna se guarda aparte, porque a veces no es
    // el primero del mes.
    const vigenciaDesde = periodoAFecha(periodoTxt) || aFecha(vigenciaTxt);

    if (!valor || !vigenciaDesde) {
      // El encabezado y los títulos caen acá; solo se reportan los que
      // parecían datos. Si la fila trae el link a la resolución, se intenta
      // completar desde el PDF antes de descartarla.
      if (/^Res|^Ac/i.test(norma)) {
        if (normaUrl) pendientesPdf.push({ norma, fechaNormaTxt, vigenciaTxt, normaUrl, celdas });
        else descartadas.push(celdas.join(' | '));
      }
      return;
    }

    filas.push({
      unidad: 'UMA',
      ambito,
      valor,
      vigenciaDesde,
      norma: norma.replace(/\s+/g, ' ').trim(),
      normaUrl,
      fechaPublicacion: aFecha(fechaNormaTxt),
      vigenciaPublicada: aFecha(vigenciaTxt),
      periodo: periodoTxt.trim(),
      leyMarco: fuente.leyMarco,
      descripcion: fuente.descripcion,
      fuente: fuente.url
    });
  });

  // Filas incompletas con link a la norma: la resolución es la fuente de
  // verdad, así que monto y vigencia se toman de su PDF.
  for (const p of pendientesPdf) {
    try {
      const datos = await extraerDatosResolucionPdf(p.normaUrl);
      if (!datos) {
        descartadas.push(p.celdas.join(' | '));
        continue;
      }
      const periodo = periodoDesdeFecha(datos.vigenciaDesde);
      logger.warn(
        `umaCpacf: la tabla trae ${p.norma} incompleta; se toman los datos del PDF de la resolución: $${datos.valor}, período ${periodo}.`
      );
      filas.push({
        unidad: 'UMA',
        ambito,
        valor: datos.valor,
        vigenciaDesde: datos.vigenciaDesde,
        norma: p.norma.replace(/\s+/g, ' ').trim(),
        normaUrl: p.normaUrl,
        fechaPublicacion: aFecha(p.fechaNormaTxt),
        vigenciaPublicada: datos.vigenciaDesde,
        periodo,
        leyMarco: fuente.leyMarco,
        descripcion: fuente.descripcion,
        fuente: fuente.url,
        verificadoPorPdf: true
      });
    } catch (e) {
      logger.warn(`umaCpacf: no se pudo leer el PDF de ${p.norma} (${p.normaUrl}): ${e.message}`);
      descartadas.push(p.celdas.join(' | '));
    }
  }

  // Cuando dos normas distintas reclaman el mismo período y alguna es reciente,
  // se contrasta contra su PDF antes del desempate: la tabla ya apareció con la
  // norma nueva rotulada con el período del mes anterior, y sin esta
  // verificación la "corrección" pisaría un valor que en realidad es de otro
  // mes.
  const porClaveVerif = new Map();
  for (const f of filas) {
    const clave = f.vigenciaDesde.toISOString().slice(0, 10);
    if (!porClaveVerif.has(clave)) porClaveVerif.set(clave, []);
    porClaveVerif.get(clave).push(f);
  }
  for (const [, grupo] of porClaveVerif) {
    if (grupo.length < 2) continue;
    for (const f of grupo) {
      const esReciente =
        f.fechaPublicacion && Date.now() - f.fechaPublicacion.getTime() < VENTANA_VERIFICACION_MS;
      if (!esReciente || f.verificadoPorPdf || !f.normaUrl) continue;
      try {
        const datos = await extraerDatosResolucionPdf(f.normaUrl);
        if (!datos) continue;
        f.verificadoPorPdf = true;
        if (datos.valor !== f.valor) {
          logger.warn(
            `umaCpacf: la tabla dice $${f.valor} para ${f.norma} pero su PDF dice $${datos.valor}; manda la resolución.`
          );
          f.valor = datos.valor;
        }
        if (+datos.vigenciaDesde !== +f.vigenciaDesde) {
          const periodoPdf = periodoDesdeFecha(datos.vigenciaDesde);
          logger.warn(
            `umaCpacf: la tabla asigna ${f.norma} al período ${f.periodo} pero su PDF fija la vigencia desde ${moment.utc(datos.vigenciaDesde).format('DD/MM/YYYY')} (${periodoPdf}); manda la resolución.`
          );
          f.vigenciaDesde = datos.vigenciaDesde;
          f.vigenciaPublicada = datos.vigenciaDesde;
          f.periodo = periodoPdf;
        }
      } catch (e) {
        logger.warn(`umaCpacf: no se pudo verificar el PDF de ${f.norma}: ${e.message}`);
      }
    }
  }

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
