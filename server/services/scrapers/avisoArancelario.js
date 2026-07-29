/**
 * Aviso por correo al administrador cuando aparece un valor arancelario nuevo.
 * ===========================================================================
 * La publicación en redes es manual por ahora: el sistema detecta la novedad,
 * arma el post en borrador y avisa. Este correo es ese aviso — dice qué cambió,
 * en qué jurisdicción y que ya hay un borrador esperando revisión.
 */

'use strict';

const { sendEmail } = require('../aws_ses/aws_sesService');
const logger = require('../../utils/logger');

// A quién se avisa. Env dedicada, con el mismo fallback que usa el resto de las
// verificaciones del repo.
const DESTINATARIO = process.env.EMAIL_ADMIN_ARANCELARIOS || 'cerramaximiliano@gmail.com';

const pesos = (n) => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2 });
const fecha = (d) => new Date(d).toLocaleDateString('es-AR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * @param {Object}   opts
 * @param {string}   opts.etiqueta  Ej: "UMA CABA".
 * @param {Object[]} opts.valores   Períodos nuevos en orden cronológico (1 o
 *                                  más: una resolución puede fijar dos meses
 *                                  de golpe, incluso con vigencia futura).
 * @param {Object}   [opts.post]    Post en borrador generado, si lo hubo.
 */
async function notificarNovedad({ etiqueta, valores, post }) {
  const lista = Array.isArray(valores) ? valores.filter(Boolean) : [valores].filter(Boolean);
  if (!lista.length) return;

  const montos = lista.map((v) => pesos(v.valor)).join(' y ');
  const asunto = lista.length > 1
    ? `Nuevos valores arancelarios: ${etiqueta} — ${montos}`
    : `Nuevo valor arancelario: ${etiqueta} — ${montos}`;

  const cuerpoPost = post
    ? `<p>Ya se generó un <strong>post en borrador</strong> con ${lista.length > 1 ? 'estos valores' : 'este valor'}. Revisalo y publicalo desde el panel.</p>`
    : `<p style="color:#b45309">No se pudo generar el post automáticamente (el contenido excede algún límite de la plantilla). Habrá que crearlo a mano.</p>`;

  const bloques = lista
    .map(
      (v) => `
      <table style="width:100%;border-collapse:collapse;font-size:15px;margin-bottom:18px">
        <tr><td style="padding:8px 0;color:#6b7899">Valor</td><td style="padding:8px 0;text-align:right;font-weight:600;font-size:20px">${pesos(v.valor)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7899;border-top:1px solid #eef1f6">Período</td><td style="padding:8px 0;text-align:right;border-top:1px solid #eef1f6">${v.periodo}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7899;border-top:1px solid #eef1f6">Vigente desde</td><td style="padding:8px 0;text-align:right;border-top:1px solid #eef1f6">${fecha(v.vigenciaDesde)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7899;border-top:1px solid #eef1f6">Norma</td><td style="padding:8px 0;text-align:right;border-top:1px solid #eef1f6">${v.norma || '—'}</td></tr>
      </table>`
    )
    .join('');

  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;color:#16203a">
      <h2 style="margin:0 0 4px">${lista.length > 1 ? 'Nuevos valores arancelarios' : 'Nuevo valor arancelario'}</h2>
      <p style="color:#4d5b7a;margin:0 0 20px">${etiqueta}</p>
      ${bloques}
      ${cuerpoPost}
      <p style="color:#8a95ad;font-size:12px;margin-top:24px">Aviso automático de la sincronización de valores arancelarios · Law Analytics</p>
    </div>`;

  const texto =
    `${lista.length > 1 ? 'Nuevos valores arancelarios' : 'Nuevo valor arancelario'} — ${etiqueta}\n` +
    lista
      .map((v) => `Valor: ${pesos(v.valor)}\nPeríodo: ${v.periodo}\nVigente desde: ${fecha(v.vigenciaDesde)}\nNorma: ${v.norma || '—'}`)
      .join('\n---\n') +
    `\n\n${post ? 'Post en borrador generado; revisalo y publicalo desde el panel.' : 'No se pudo generar el post automáticamente; crearlo a mano.'}`;

  // Permite ejercitar el flujo completo sin enviar correos reales durante
  // pruebas: ARANCELARIOS_DRY_EMAIL=1 lo loguea en vez de mandarlo.
  if (process.env.ARANCELARIOS_DRY_EMAIL === '1') {
    logger.info(`avisoArancelario [DRY]: correo a ${DESTINATARIO} por ${etiqueta} — ${montos}.`);
    return;
  }

  try {
    await sendEmail(DESTINATARIO, asunto, html, texto);
    logger.info(`avisoArancelario: correo enviado a ${DESTINATARIO} por ${etiqueta}.`);
  } catch (err) {
    // El aviso no debe voltear la sincronización: si SES falla, se registra y
    // sigue. El valor ya quedó en la base y el post en borrador.
    logger.error(`avisoArancelario: no se pudo enviar el correo (${etiqueta}): ${err.message}`);
  }
}

module.exports = { notificarNovedad };
