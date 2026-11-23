'use strict';
/**
 * Aviso por correo cuando una serie mensual (IPC, RIPTE, inflación) trae un mes nuevo o la
 * fuente corrige un mes ya cargado. Sale del cron `indices-mensuales`, solo si hay novedades.
 * El atraso (un mes que debería estar y no llegó) lo informa el reporte diario de tasas.
 */
const moment = require('moment');
const { sendEmail } = require('../../aws_ses/aws_sesService');
const logger = require('../../../utils/logger');

const DESTINATARIO = process.env.EMAIL_ADMIN_INDICES || process.env.EMAIL_ADMIN_ARANCELARIOS || 'cerramaximiliano@gmail.com';
const MAX_FILAS = 36;
const num = (n) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 4 });
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')} %` : '—');
const dia = (d) => moment.utc(d).format('DD/MM/YYYY');

/**
 * Arma asunto y cuerpos. Función pura.
 * @param {Array<{serie, descripcion, novedades:Array, proximo:{periodo, fecha}}>} series
 */
function armarAviso(series) {
	const conNovedad = series.filter((s) => s.novedades && s.novedades.length);
	if (!conNovedad.length) return null;
	const titulares = conNovedad.map((s) => {
		const nuevos = s.novedades.filter((n) => n.tipo === 'nuevo');
		const ultimo = nuevos[nuevos.length - 1];
		if (ultimo) return `${s.descripcion} ${ultimo.periodo}: ${num(ultimo.valor)}${Number.isFinite(ultimo.variacion) ? ` (${pct(ultimo.variacion)})` : ''}`;
		return `${s.descripcion}: ${s.novedades.length} ${s.novedades.length > 1 ? 'meses corregidos' : 'mes corregido'}`;
	});
	const asunto = `Índices mensuales — ${titulares.join(' · ')}`;

	const fila = (n) => (n.tipo === 'nuevo'
		? `<tr><td style="padding:6px 8px">${n.periodo}</td><td style="padding:6px 8px">nuevo</td><td style="padding:6px 8px;text-align:right">${num(n.valor)}</td><td style="padding:6px 8px;text-align:right">${pct(n.variacion)}</td></tr>`
		: `<tr><td style="padding:6px 8px">${n.periodo}</td><td style="padding:6px 8px;color:#b45309">corregido</td><td style="padding:6px 8px;text-align:right">${num(n.anterior)} → ${num(n.valor)}</td><td style="padding:6px 8px;text-align:right">—</td></tr>`);
	const bloques = conNovedad.map((s) => `
		<h3 style="margin:18px 0 4px">${s.descripcion}</h3>
		<table style="border-collapse:collapse;width:100%;font-size:14px;border:1px solid #e5e9f2">
			<tr style="background:#f3f5fa"><th style="padding:6px 8px;text-align:left">Mes</th><th style="padding:6px 8px;text-align:left">Novedad</th><th style="padding:6px 8px;text-align:right">Valor</th><th style="padding:6px 8px;text-align:right">Variación mensual</th></tr>
			${s.novedades.slice(-MAX_FILAS).map(fila).join('')}
		</table>
		${s.novedades.length > MAX_FILAS ? `<p style="color:#4d5b7a;font-size:13px;margin:6px 0 0">Se muestran los últimos ${MAX_FILAS} de ${s.novedades.length} meses con novedad.</p>` : ''}
		<p style="color:#4d5b7a;font-size:13px;margin:6px 0 0">Fuente: ${s.novedades[s.novedades.length - 1].fuente || 's/d'}.${s.proximo ? ` Próximo dato: ${s.proximo.periodo}, esperado el ${dia(s.proximo.fecha)}.` : ''}</p>`).join('');
	const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;color:#16203a">
		<h2 style="margin:0 0 4px">Índices mensuales actualizados</h2>
		<p style="color:#4d5b7a;margin:0">Guardados en Atlas (indicesmensuales). El seguimiento de cada serie está en las tareas del admin.</p>
		${bloques}
		<p style="color:#8a95ad;font-size:12px;margin-top:24px">Aviso automático del servicio de tasas · Law Analytics</p></div>`;
	const texto = conNovedad.map((s) => [
		s.descripcion,
		...s.novedades.slice(-MAX_FILAS).map((n) => (n.tipo === 'nuevo' ? `  ${n.periodo}: ${num(n.valor)} (${pct(n.variacion)})` : `  ${n.periodo} corregido: ${num(n.anterior)} -> ${num(n.valor)}`)),
		s.proximo ? `  Próximo: ${s.proximo.periodo}, esperado el ${dia(s.proximo.fecha)}` : '',
	].filter(Boolean).join('\n')).join('\n\n');
	return { asunto, html, texto };
}

async function notificarNovedades(series) {
	const aviso = armarAviso(series);
	if (!aviso) return false;
	if (process.env.INDICES_DRY_EMAIL === '1') {
		logger.info(`avisoIndices [DRY]: ${aviso.asunto}`);
		return false;
	}
	try {
		await sendEmail(DESTINATARIO, aviso.asunto, aviso.html, aviso.texto, []);
		logger.info(`avisoIndices: correo enviado a ${DESTINATARIO} — ${aviso.asunto}`);
		return true;
	} catch (e) {
		// El aviso no voltea la actualización: el dato ya quedó guardado.
		logger.error(`avisoIndices: no se pudo enviar el correo: ${e.message}`);
		return false;
	}
}

module.exports = { armarAviso, notificarNovedades };
