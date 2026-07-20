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

const LIMITES = { unidad: 6, norma: 26, bajada: 64, valor: 14, periodo: 24, resolucion: 46 };

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
function armarContenido(doc) {
  const desde = fechaCorta(doc.vigenciaDesde);
  let resolucion;
  if (doc.norma && doc.fechaPublicacion) resolucion = `${doc.norma} · publicada ${fechaCorta(doc.fechaPublicacion)}`;
  else if (doc.norma && doc.norma !== doc.leyMarco) resolucion = `${doc.norma} · desde ${desde}`;
  else resolucion = `Vigente desde ${desde}`;

  return {
    unidad: doc.unidad,
    norma: doc.leyMarco,
    bajada: doc.descripcion,
    valor: pesos(doc.valor),
    periodo: periodoTexto(doc.vigenciaDesde),
    resolucion,
    variante: 'ficha'
  };
}

/** Campos del contenido que exceden el límite de la plantilla. */
function excesos(contenido) {
  return Object.entries(LIMITES)
    .filter(([campo, max]) => typeof contenido[campo] === 'string' && contenido[campo].length > max)
    .map(([campo, max]) => `${campo} ${contenido[campo].length}/${max}`);
}

/**
 * Crea el post (estado borrador) para el valor vigente `doc`. Devuelve el
 * documento insertado, o null si el contenido no pasa los límites.
 * @param {import('mongodb').Db} db  Conexión nativa a la base compartida.
 */
async function crearPostValorArancelario(db, doc) {
  const contenido = armarContenido(doc);
  const problemas = excesos(contenido);
  if (problemas.length) {
    logger.warn(`valorArancelarioPost: ${doc.unidad} ${doc.ambito} excede límites (${problemas.join(', ')}); no se crea el post.`);
    return null;
  }

  const ahora = new Date();
  const post = {
    titulo: `${doc.unidad} ${doc.ambito} — ${contenido.periodo}`,
    templateId: 'valor-arancel',
    formato: 'feed34',
    prompt: '',
    contenido,
    caption: `${doc.unidad} ${doc.ambito} — último valor publicado: ${contenido.valor}, correspondiente a ${contenido.periodo}. ${contenido.resolucion}.`,
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
