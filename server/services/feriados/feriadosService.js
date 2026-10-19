/**
 * Calendario de días inhábiles judiciales (colección `feriados-judiciales`,
 * la que usan los plazos automáticos para calcular vencimientos).
 *
 * Dos tareas:
 *   - controlarCalendario (semanal): avisa por correo si la cobertura del
 *     calendario baja de COBERTURA_MIN_DIAS o si hay días inhábiles sin
 *     verificar en los próximos PROXIMOS_DIAS (traslados, feria de julio
 *     estimada). Sin problemas no manda nada.
 *   - generarAnioSiguiente (anual, 1/9): carga el año que viene con las reglas
 *     de feriados-calendario.js (solo inserta lo que falta) y avisa qué quedó
 *     sin verificar. También la dispara el control si la cobertura es corta.
 *
 * Base: la maestra del calendario, Atlas desde el 19/10 (P8 de plazos
 * automáticos, la-ads/docs/producto/plazos-automaticos.md). Las dos tareas
 * corren por defecto; FERIADOS_TAREAS=false las apaga. FERIADOS_URLDB permite
 * apuntar a otra base (default: la de la app, URLDB = Atlas). Ojo: app.js
 * reescribe el .env desde Secrets Manager al arrancar, así que un interruptor
 * puesto a mano en el .env se pierde con el reinicio.
 */

'use strict';

const mongoose = require('mongoose');
const logger = require('../../utils/logger');
const { sendEmail } = require('../aws_ses/aws_sesService');
const cal = require('./feriados-calendario');

const DESTINATARIO = process.env.EMAIL_ADMIN_FERIADOS || 'cerramaximiliano@gmail.com';
const COBERTURA_MIN_DIAS = 120; // los plazos llegan a 60 días; con 120 hay margen para verificar
const PROXIMOS_DIAS = 90;
const ADMIN_URL = 'https://dashboard.lawanalytics.app/admin/causas/plazos?tab=feriados';

const activo = () => process.env.FERIADOS_TAREAS !== 'false';

let conexionPropia = null;
async function coleccion() {
  if (!process.env.FERIADOS_URLDB) return mongoose.connection.db.collection(cal.COLECCION);
  if (!conexionPropia) conexionPropia = await mongoose.createConnection(process.env.FERIADOS_URLDB).asPromise();
  return conexionPropia.db.collection(cal.COLECCION);
}

const escapar = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function avisar(asunto, lineas) {
  const texto = `${lineas.join('\n')}\n\nCalendario: ${ADMIN_URL}`;
  const html = `<pre style="font-family:monospace">${escapar(lineas.join('\n'))}</pre><p><a href="${ADMIN_URL}">Abrir el calendario en la admin</a></p>`;
  await sendEmail(DESTINATARIO, asunto, html, texto, []);
  logger.info(`feriados: aviso enviado (${asunto})`);
}

/**
 * Carga el año siguiente si falta (o el indicado). Solo inserta lo que falta.
 * @param {Object} [opts] — { anio, avisarSiNada = false }
 */
async function generarAnioSiguiente({ anio = null, avisarSiNada = false } = {}) {
  if (!activo()) return { omitido: 'FERIADOS_TAREAS=false' };
  const c = await coleccion();
  const y = anio || new Date().getFullYear() + 1;
  const r = await cal.generarAnio(c, y, { aplicar: true });
  logger.info(`feriados: generar ${y} → ${r.agregan.length} días nuevos, ${r.existentes} ya estaban, ${r.sinVerificar} sin verificar`);
  if (r.agregan.length || avisarSiNada) {
    await avisar(`Feriados judiciales: se cargó el calendario ${y}`, [
      `Se cargó el calendario de días inhábiles de ${y}: ${r.agregan.length} días nuevos (${r.existentes} ya estaban).`,
      `${r.sinVerificar} quedaron SIN VERIFICAR y hay que confirmarlos:`,
      `  - feriados trasladables (17/6, 17/8, 12/10, 20/11): contra el decreto anual de feriados;`,
      `  - feria de julio (estimada ${cal.feriaJulioEstimada(y).join(' a ')}): contra la acordada de la CSJN;`,
      `  - puentes turísticos: no se estiman, cargarlos a mano cuando salga el decreto.`,
    ]);
  }
  return r;
}

/** Control semanal: cobertura y días sin verificar próximos. Avisa solo si hay algo. */
async function controlarCalendario() {
  if (!activo()) return { omitido: 'FERIADOS_TAREAS=false' };
  const c = await coleccion();
  let cob = await cal.cobertura(c);
  let generado = null;
  if (cob.diasRestantes === null || cob.diasRestantes < COBERTURA_MIN_DIAS) {
    generado = await generarAnioSiguiente({ anio: (cob.ultimoAnio || new Date().getFullYear() - 1) + 1 });
    cob = await cal.cobertura(c);
  }
  const sinVerificar = await cal.sinVerificarProximos(c, { dias: PROXIMOS_DIAS });
  const problemas = [];
  if (cob.diasRestantes === null || cob.diasRestantes < COBERTURA_MIN_DIAS) {
    problemas.push(`Cobertura corta: el calendario llega hasta ${cob.hasta || '— (sin año actual completo)'} (${cob.diasRestantes ?? 0} días). Los plazos que venzan después no se entregan.`);
  }
  if (cob.aniosIncompletos.length) problemas.push(`Años incompletos (falta la feria de enero o Navidad): ${cob.aniosIncompletos.join(', ')}.`);
  if (sinVerificar.length) {
    problemas.push(`${sinVerificar.length} días inhábiles SIN VERIFICAR en los próximos ${PROXIMOS_DIAS} días (los plazos que los atraviesan se marcan "calendario sin confirmar"):`);
    for (const d of sinVerificar) problemas.push(`  ${d.fecha}  ${d.tipo}  ${d.descripcion || ''}`);
  }
  logger.info(`feriados: control — cobertura hasta ${cob.hasta} (${cob.diasRestantes} días), ${sinVerificar.length} sin verificar en ${PROXIMOS_DIAS} días`);
  if (problemas.length) await avisar('Feriados judiciales: hay que revisar el calendario', problemas);
  return { cobertura: cob, sinVerificar: sinVerificar.length, generado: generado && generado.agregan ? generado.agregan.length : 0, avisado: problemas.length > 0 };
}

module.exports = { controlarCalendario, generarAnioSiguiente, COBERTURA_MIN_DIAS, PROXIMOS_DIAS };
