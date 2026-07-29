/**
 * Sincronización de valores arancelarios (UMA, JUS y afines) contra la base.
 * =========================================================================
 * Genérico respecto de la fuente: recibe un scraper que devuelve la serie ya
 * parseada y se encarga del resto —comparar contra lo cargado, avisar de
 * correcciones, upsert idempotente, registrar el estado de la tarea, y disparar
 * el post + el aviso por correo cuando aparece un valor genuinamente nuevo—.
 * Cada unidad nueva es un scraper propio y una entrada de cron, sin duplicar
 * esta lógica.
 *
 * NO abre ni cierra la conexión a Mongo: usa la del proceso. Un sync que cierra
 * la conexión compartida al terminar dejaría al resto de los crons sin base.
 */

'use strict';

const mongoose = require('mongoose');
const ValorArancelario = require('../../models/valoresArancelarios');
const ArancelariosConfig = require('../../models/arancelariosConfig');
const logger = require('../../utils/logger');
const { crearPostValorArancelario } = require('../social/valorArancelarioPost');
const { notificarNovedad } = require('./avisoArancelario');

const CONFIG_ID = 'arancelarios-config';

/** Persiste el estado de la última corrida de una fuente en el config único. */
async function registrarEstado(clave, datos) {
  if (!clave) return;
  const set = {};
  for (const [k, v] of Object.entries(datos)) set[`fuentes.${clave}.${k}`] = v;
  await ArancelariosConfig.updateOne({ _id: CONFIG_ID }, { $set: set }, { upsert: true });
}

/**
 * @param {Object} opts
 * @param {Function} opts.obtener   Scraper: async () => filas[].
 * @param {string}   opts.etiqueta  Nombre para logs y avisos. Ej: "UMA PJN".
 * @param {string}   [opts.clave]   Clave de la fuente en el config. Ej: "uma-pjn".
 * @param {boolean}  [opts.simular=false]  No escribe, no avisa; solo informa.
 */
async function sincronizarValores({ obtener, etiqueta, clave, simular = false }) {
  const inicio = Date.now();

  let filas;
  try {
    filas = await obtener();
  } catch (err) {
    // Si la fuente cambió de forma, se registra el error en el config para que
    // el panel lo muestre, y se propaga para que el cron lo loguee.
    if (!simular) {
      await registrarEstado(clave, {
        etiqueta,
        ultimaEjecucion: new Date(),
        ultimoEstado: 'error',
        ultimoError: err.message,
        duracionMs: Date.now() - inicio
      }).catch(() => {});
    }
    throw err;
  }

  let nuevos = 0;
  let corregidos = 0;
  let sinCambios = 0;

  for (const f of filas) {
    const claveDoc = { unidad: f.unidad, ambito: f.ambito, vigenciaDesde: f.vigenciaDesde };
    const previo = await ValorArancelario.findOne(claveDoc);

    if (previo && previo.valor === f.valor) {
      sinCambios++;
      continue;
    }
    if (previo) {
      corregidos++;
      logger.warn(`syncValores[${etiqueta}]: ${f.periodo} cambió de ${previo.valor} a ${f.valor} (${f.norma}).`);
    } else {
      nuevos++;
    }
    if (!simular) {
      await ValorArancelario.findOneAndUpdate(claveDoc, { $set: { ...f, estado: true } }, { upsert: true, setDefaultsOnInsert: true });
    }
  }

  // Valor vigente al cierre. La referencia es el primer elemento (los scrapers
  // devuelven la serie de más nuevo a más viejo).
  const referencia = filas[0] || {};
  const vigente = referencia.unidad ? await ValorArancelario.vigente(referencia.unidad, referencia.ambito) : null;

  // ── Detección de novedad ──────────────────────────────────────────────────
  // Post + aviso cuando aparece un período MÁS NUEVO que el último ya avisado,
  // AUNQUE su vigencia sea futura: una resolución que fija dos meses de golpe
  // (la UMA CABA lo hace) se anuncia completa el día que se publica, no a
  // medida que cada mes entra en vigencia. En la primera corrida no hay
  // "último avisado", así que se registra la línea de base sin avisar: la
  // carga histórica no debe generar decenas de posts ni correos.
  let post = null;
  let esNovedad = false;
  let anunciados = [];
  if (!simular && filas.length) {
    const cfg = await ArancelariosConfig.findById(CONFIG_ID);
    const previa = cfg && cfg.fuentes ? cfg.fuentes.get(clave) : null;
    const vigenciaAvisada = previa && previa.ultimaVigenciaAvisada ? new Date(previa.ultimaVigenciaAvisada).getTime() : null;

    // Períodos todavía no avisados, del más viejo al más nuevo.
    const pendientes = vigenciaAvisada === null
      ? []
      : filas
          .filter((f) => f.vigenciaDesde.getTime() > vigenciaAvisada)
          .sort((a, b) => a.vigenciaDesde - b.vigenciaDesde);

    if (pendientes.length) {
      esNovedad = true;
      anunciados = pendientes;

      // Si la resolución del período más nuevo fijó exactamente dos períodos,
      // el post los muestra juntos —aunque el primero ya se hubiera avisado
      // suelto en una corrida anterior—. Con una sola fila (o normas largas
      // rectificatorias que abarcan más de dos), post simple del más nuevo.
      const masNuevo = pendientes[pendientes.length - 1];
      const deLaMismaNorma = masNuevo.norma
        ? filas
            .filter((f) => f.norma === masNuevo.norma)
            .sort((a, b) => a.vigenciaDesde - b.vigenciaDesde)
        : [masNuevo];

      if (deLaMismaNorma.length === 2) {
        post = await crearPostValorArancelario(mongoose.connection.db, deLaMismaNorma[0], deLaMismaNorma[1]);
      } else {
        post = await crearPostValorArancelario(mongoose.connection.db, masNuevo);
      }
      await notificarNovedad({ etiqueta, valores: pendientes, post });
    }
  }

  // ── Registro de estado ────────────────────────────────────────────────────
  if (!simular) {
    const estado = {
      etiqueta,
      unidad: referencia.unidad,
      ambito: referencia.ambito,
      url: referencia.fuente,
      ultimaEjecucion: new Date(),
      ultimoEstado: 'ok',
      ultimoError: null,
      duracionMs: Date.now() - inicio,
      publicados: filas.length,
      nuevos,
      corregidos,
      sinCambios
    };
    if (vigente) {
      estado.vigente = { valor: vigente.valor, periodo: vigente.periodo, norma: vigente.norma, vigenciaDesde: vigente.vigenciaDesde };
    }
    // Avanza la línea de base siempre: en la primera corrida la fija, en las
    // siguientes se mueve al período más nuevo PUBLICADO —no al vigente—. Si
    // la fuente adelantó un mes futuro, ya quedó avisado acá arriba y no debe
    // volver a anunciarse cuando entre en vigencia.
    if (referencia.vigenciaDesde) {
      estado.ultimaVigenciaAvisada = referencia.vigenciaDesde;
    }
    // Escalón publicado que todavía no rige (vigencia futura), para que el
    // panel pueda mostrar "ya está fijado el valor del mes que viene". Null
    // cuando no hay: así el campo no queda pegado de una corrida anterior.
    const ahora = Date.now();
    const anticipadas = filas.filter((f) => f.vigenciaDesde.getTime() > ahora);
    const proximo = anticipadas.length ? anticipadas[anticipadas.length - 1] : null;
    estado.proximo = proximo
      ? { valor: proximo.valor, periodo: proximo.periodo, norma: proximo.norma, vigenciaDesde: proximo.vigenciaDesde }
      : null;
    if (post) {
      estado.ultimoPostId = post._id;
      estado.ultimoPostFecha = new Date();
    }
    await registrarEstado(clave, estado);
  }

  const resumen = {
    publicados: filas.length,
    nuevos,
    corregidos,
    sinCambios,
    esNovedad,
    anunciados: anunciados.map((f) => f.periodo),
    post: post ? { _id: post._id, titulo: post.titulo } : null,
    vigente: vigente ? { valor: vigente.valor, periodo: vigente.periodo, norma: vigente.norma } : null
  };

  logger.info(
    `syncValores[${etiqueta}]: ${resumen.publicados} publicados · ${nuevos} nuevos · ${corregidos} corregidos · vigente ${vigente ? vigente.valor + ' (' + vigente.periodo + ')' : 'ninguno'}${esNovedad ? ` · NOVEDAD ${resumen.anunciados.join(' + ')} (post+aviso)` : ''}${simular ? ' [simulado]' : ''}`
  );

  return resumen;
}

module.exports = { sincronizarValores };
