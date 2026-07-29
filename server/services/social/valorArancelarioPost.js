/**
 * Genera el post social de un valor arancelario a partir del documento vigente.
 * ============================================================================
 * El armado del contenido replica el del generador de la-marketing-service
 * (scripts/socialValorArancelario.js): tiene que producir EXACTAMENTE el mismo
 * documento, porque los dos escriben en la colección `socialposts` y un post
 * autogenerado no puede verse distinto de uno hecho a mano. Si aquel cambia,
 * este tiene que acompañar. Se inserta directo en la colección compartida en
 * vez de pasar por el modelo de marketing (que vive en otro repo).
 *
 * Los límites de la plantilla `valor-arancel` se chequean antes de insertar: si
 * un texto excede, no se crea el post (se avisa por log) para no ensuciar la
 * colección con un documento que la UI marcaría como inválido.
 */

'use strict';

const logger = require('../../utils/logger');

const LIMITES = { unidad: 6, norma: 26, bajada: 64, valor: 14, periodo: 24, valor2: 14, periodo2: 24, resolucion: 46 };

/** '$726.032,80' con centavos solo si los hay; '$58.465' si es entero. */
function pesos(n) {
  const entero = Number.isInteger(Number(n));
  return '$' + Number(n).toLocaleString('es-AR', {
    minimumFractionDigits: entero ? 0 : 2,
    maximumFractionDigits: 2
  });
}

/** 'Julio 2026' — mes y año, capitalizado, sin "de". */
function periodoTexto(fecha) {
  const s = new Date(fecha)
    .toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .replace(' de ', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const fechaCorta = (d) =>
  new Date(d).toLocaleDateString('es-AR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });

/** Arma el objeto `contenido` de la plantilla valor-arancel desde el doc. */
// La línea de resolución tiene un límite (46). Algunas fuentes traen normas
// largas --Santa Fe: "Resolución de Secretaría de Gobierno de fecha X",
// Río Negro: "Resolución Conjunta Nº ... STJ y ... PG"-- que no entran. Se
// degrada con elegancia: se prueba la forma completa, luego la norma sola, y si
// nada entra se cae a "Vigente desde", que siempre es válida. La norma completa
// no se pierde: queda en el registro y se ve en la vista de Datos Arancelarios.
function armarResolucion(doc) {
  const desde = fechaCorta(doc.vigenciaDesde);
  const cabe = (t) => t.length <= LIMITES.resolucion;
  const candidatos = [];
  if (doc.norma && doc.fechaPublicacion) candidatos.push(`${doc.norma} · publicada ${fechaCorta(doc.fechaPublicacion)}`);
  else if (doc.norma && doc.norma !== doc.leyMarco) candidatos.push(`${doc.norma} · desde ${desde}`);
  if (doc.norma && doc.norma !== doc.leyMarco) candidatos.push(doc.norma);
  candidatos.push(`Vigente desde ${desde}`);
  return candidatos.find(cabe) || `Vigente desde ${desde}`;
}

/**
 * @param {Object} doc          Escalón principal (el más viejo si son dos).
 * @param {Object} [docSegundo] Segundo período fijado por la MISMA resolución
 *                              (vigencia posterior a la de `doc`). Activa el
 *                              layout doble de la plantilla.
 */
function armarContenido(doc, docSegundo) {
  const resolucion = armarResolucion(doc);

  const contenido = {
    unidad: doc.unidad,
    norma: doc.leyMarco,
    bajada: doc.descripcion,
    valor: pesos(doc.valor),
    periodo: periodoTexto(doc.vigenciaDesde),
    resolucion,
    variante: 'ficha'
  };
  if (docSegundo) {
    contenido.valor2 = pesos(docSegundo.valor);
    contenido.periodo2 = periodoTexto(docSegundo.vigenciaDesde);
  }
  return contenido;
}

/** Campos del contenido que exceden el límite de la plantilla. */
function excesos(contenido) {
  return Object.entries(LIMITES)
    .filter(([campo, max]) => typeof contenido[campo] === 'string' && contenido[campo].length > max)
    .map(([campo, max]) => `${campo} ${contenido[campo].length}/${max}`);
}

/**
 * Crea el post (estado borrador) para el valor `doc`. Si `docSegundo` viene,
 * el post muestra los dos períodos que la misma resolución fijó de golpe.
 * Devuelve el documento insertado, o null si el contenido no pasa los límites.
 * @param {import('mongodb').Db} db  Conexión nativa a la base compartida.
 */
async function crearPostValorArancelario(db, doc, docSegundo = null) {
  const contenido = armarContenido(doc, docSegundo);
  const problemas = excesos(contenido);
  if (problemas.length) {
    logger.warn(`valorArancelarioPost: ${doc.unidad} ${doc.ambito} excede límites (${problemas.join(', ')}); no se crea el post.`);
    return null;
  }

  // "Julio y Agosto 2026" cuando los dos períodos son del mismo año; con el
  // año de cada uno cuando el par cruza el fin de año (Dic 2026 y Ene 2027).
  const periodoTitulo = docSegundo
    ? (contenido.periodo.slice(-4) === contenido.periodo2.slice(-4)
        ? `${contenido.periodo.slice(0, -5)} y ${contenido.periodo2}`
        : `${contenido.periodo} y ${contenido.periodo2}`)
    : contenido.periodo;

  const ahora = new Date();
  const post = {
    titulo: `${doc.unidad} ${doc.ambito} — ${periodoTitulo}`,
    templateId: 'valor-arancel',
    formato: 'feed34',
    prompt: '',
    contenido,
    caption: docSegundo
      ? `${doc.unidad} ${doc.ambito} — ${contenido.resolucion} fija dos valores: ${contenido.valor} para ${contenido.periodo} y ${contenido.valor2} para ${contenido.periodo2}.`
      : `${doc.unidad} ${doc.ambito} — último valor publicado: ${contenido.valor}, correspondiente a ${contenido.periodo}. ${contenido.resolucion}.`,
    hashtags: ['abogados', 'honorarios', 'legaltech'],
    estado: 'borrador',
    // Marca de origen: el post lo generó la sincronización, no una persona.
    generacion: { modelo: 'sync-arancelarios', inputTokens: null, outputTokens: null, generadoEn: ahora },
    estilo: null,
    composicion: null,
    pie: null,
    animacion: 'entrada',
    duracionSeg: null,
    duplicadoDe: null,
    creadoPor: null,
    createdAt: ahora,
    updatedAt: ahora,
    __v: 0
  };

  const { insertedId } = await db.collection('socialposts').insertOne(post);
  logger.info(`valorArancelarioPost: post creado ${insertedId} — ${post.titulo}.`);
  return { _id: insertedId, ...post };
}

module.exports = { crearPostValorArancelario, armarContenido };
