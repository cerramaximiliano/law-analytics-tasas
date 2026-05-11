/**
 * Servicio de auditoría de cobertura de la colección `datosprevisionales`.
 *
 * Verifica que los datos necesarios para el cómputo previsional estén poblados
 * antes de que comience el mes siguiente. Si encuentra gaps o valores faltantes,
 * envía un email de alerta a `soporte@lawanalytics.app`.
 *
 * Diseñado para correr como cron el último día de cada mes (vía taskService).
 *
 * Campos auditados (del schema actualizado en law-analytics-server):
 *   - movilidadGeneral (siempre, no debe ser ≤ 0).
 *   - haberMinimoJubilacion (siempre desde 1995).
 *   - salarioMVM (necesario para piso 82% desde 1/2018).
 *
 * Gaps son considerados:
 *   CRITICAL: documento del mes próximo no existe; movilidadGeneral inválida.
 *   WARNING:  haberMinimoJubilacion o salarioMVM faltantes en mes próximo;
 *             trimestre típico (mar/jun/sep/dic) sin movilidad publicada.
 */

const mongoose = require('mongoose');
const moment = require('moment');
const logger = require('../../utils/logger');
const { sendEmail } = require('../aws_ses/aws_sesService');

const COLLECTION = 'datosprevisionales';
const FECHA_REGLA_82 = moment.utc('2018-01-01');

const MES_NOMBRE = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const formatMes = (fecha) => `${MES_NOMBRE[fecha.month()]} ${fecha.year()}`;

/**
 * Verifica si hoy es el último día del mes actual (esto es: mañana es día 1).
 */
function esUltimoDiaDelMes() {
	const manana = moment().add(1, 'day');
	return manana.date() === 1;
}

/**
 * Devuelve la fecha del primer día del mes próximo (en UTC, primer día = ancla del documento).
 */
function fechaMesProximo() {
	return moment.utc().startOf('month').add(1, 'month').toDate();
}

function fechaMesActual() {
	return moment.utc().startOf('month').toDate();
}

/**
 * Auditoría de cobertura. Devuelve `{ warnings, summary }`.
 * No envía emails — separado para testabilidad.
 */
async function auditarCobertura() {
	if (mongoose.connection.readyState !== 1) {
		throw new Error('MongoDB no está conectado');
	}
	const collection = mongoose.connection.db.collection(COLLECTION);

	const warnings = [];
	const fechaProx = fechaMesProximo();
	const fechaAct = fechaMesActual();

	const docProx = await collection.findOne({ fecha: fechaProx });
	const docAct = await collection.findOne({ fecha: fechaAct });

	const labelProx = formatMes(moment.utc(fechaProx));
	const labelAct = formatMes(moment.utc(fechaAct));

	// 1. Existe documento para el mes próximo
	if (!docProx) {
		warnings.push({
			severity: 'critical',
			campo: 'documento',
			mes: labelProx,
			mensaje: `No existe documento en datosprevisionales para ${labelProx}.`,
		});
	} else {
		// 1a. movilidadGeneral debe estar poblada y > 0
		const movGen = Number(docProx.movilidadGeneral);
		if (!Number.isFinite(movGen) || movGen <= 0) {
			warnings.push({
				severity: 'critical',
				campo: 'movilidadGeneral',
				mes: labelProx,
				mensaje: `movilidadGeneral inválida en ${labelProx} (valor: ${docProx.movilidadGeneral}).`,
			});
		}

		// 1b. haberMinimoJubilacion debe estar poblada (en general lo está desde 1995)
		const hMin = Number(docProx.haberMinimoJubilacion);
		if (!Number.isFinite(hMin) || hMin <= 0) {
			warnings.push({
				severity: 'critical',
				campo: 'haberMinimoJubilacion',
				mes: labelProx,
				mensaje: `haberMinimoJubilacion faltante en ${labelProx}. Afecta el piso del haber.`,
			});
		}

		// 1c. salarioMVM (regla 82%) — solo crítico si la regla aplica (>= 2018)
		const aplicaRegla82 = moment.utc(fechaProx).isSameOrAfter(FECHA_REGLA_82);
		const smvym = Number(docProx.salarioMVM);
		if (aplicaRegla82 && (!Number.isFinite(smvym) || smvym <= 0)) {
			warnings.push({
				severity: 'warning',
				campo: 'salarioMVM',
				mes: labelProx,
				mensaje: `salarioMVM faltante en ${labelProx}. Si el haber mínimo no supera el 82% × SMVyM, el piso queda subestimado. Ejecutar setSalarioMVM.js con el valor publicado.`,
			});
		}
	}

	// 2. Verificar mes actual también (por si se cargó tarde)
	if (!docAct) {
		warnings.push({
			severity: 'critical',
			campo: 'documento',
			mes: labelAct,
			mensaje: `No existe documento en datosprevisionales para ${labelAct} (mes corriente).`,
		});
	}

	// 3. Sanity: ningún doc con movilidadGeneral ≤ 0 en últimos 24 meses
	const hace24 = moment.utc().startOf('month').subtract(24, 'months').toDate();
	const docsInvalidos = await collection
		.find({
			fecha: { $gte: hace24 },
			$or: [
				{ movilidadGeneral: { $lte: 0 } },
				{ movilidadGeneral: { $exists: false } },
				{ movilidadGeneral: null },
			],
		})
		.project({ fecha: 1 })
		.toArray();

	if (docsInvalidos.length > 0) {
		const lista = docsInvalidos.map((d) => formatMes(moment.utc(d.fecha))).join(', ');
		warnings.push({
			severity: 'critical',
			campo: 'movilidadGeneral',
			mes: 'múltiples',
			mensaje: `${docsInvalidos.length} documento(s) en últimos 24 meses con movilidadGeneral inválida: ${lista}.`,
		});
	}

	// 4. Trimestre típico (mar/jun/sep/dic): si el mes próximo es trimestral y movilidadGeneral = 1,
	//    podría estar pendiente la publicación del aumento ANSES.
	const mProx = moment.utc(fechaProx).month(); // 0-indexed
	const esTrimestral = [2, 5, 8, 11].includes(mProx);
	if (esTrimestral && docProx) {
		const movGen = Number(docProx.movilidadGeneral) || 0;
		if (movGen <= 1.0001) {
			warnings.push({
				severity: 'warning',
				campo: 'movilidadGeneral',
				mes: labelProx,
				mensaje: `${labelProx} es un trimestre típico de movilidad ANSES (mar/jun/sep/dic) pero movilidadGeneral = ${movGen}. Verificar si ANSES ya publicó el aumento.`,
			});
		}
	}

	const summary = {
		mesAuditado: labelProx,
		critical: warnings.filter((w) => w.severity === 'critical').length,
		warning: warnings.filter((w) => w.severity === 'warning').length,
		ok: warnings.length === 0,
	};

	return { warnings, summary };
}

/**
 * Construye el HTML y el texto plano del email de alerta.
 */
function construirEmail(warnings, summary) {
	const fechaHoy = moment().format('DD/MM/YYYY');

	const subject = summary.ok
		? `[Audit datosprevisionales] OK — ${summary.mesAuditado} listo (${fechaHoy})`
		: `[Audit datosprevisionales] ${summary.critical} críticos / ${summary.warning} warnings — ${summary.mesAuditado}`;

	const bullets = warnings
		.map(
			(w) =>
				`  · [${w.severity.toUpperCase()}] ${w.campo} (${w.mes}): ${w.mensaje}`,
		)
		.join('\n');

	const textBody = `
Auditoría de cobertura de datosprevisionales — ${fechaHoy}

Mes próximo (que comienza mañana): ${summary.mesAuditado}
Críticos: ${summary.critical}
Warnings: ${summary.warning}

${
		warnings.length === 0
			? 'No se encontraron problemas. La BD está lista para el próximo mes.'
			: 'Detalle:\n' + bullets
	}

---
Este mensaje fue generado automáticamente por el cron auditDatosPrevisionales en law-analytics-admin.
`.trim();

	const bulletsHtml = warnings
		.map((w) => {
			const color = w.severity === 'critical' ? '#c62828' : '#ef6c00';
			return `<li style="margin: 6px 0;"><strong style="color:${color}">[${w.severity.toUpperCase()}] ${w.campo}</strong> <em>(${w.mes})</em>: ${w.mensaje}</li>`;
		})
		.join('');

	const htmlBody = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; max-width: 720px; margin: 0 auto; padding: 16px;">
  <h2 style="border-bottom: 2px solid #1976d2; padding-bottom: 8px;">Auditoría de datosprevisionales</h2>
  <p><strong>Fecha:</strong> ${fechaHoy}</p>
  <p><strong>Mes próximo (que comienza mañana):</strong> ${summary.mesAuditado}</p>
  <p>
    <span style="color:#c62828">Críticos: ${summary.critical}</span> &nbsp;
    <span style="color:#ef6c00">Warnings: ${summary.warning}</span>
  </p>
  ${
		warnings.length === 0
			? '<p style="color:#2e7d32;"><strong>✓ No se encontraron problemas.</strong> La BD está lista para el próximo mes.</p>'
			: `<h3>Detalle</h3><ul>${bulletsHtml}</ul>`
	}
  <hr style="margin-top: 24px; border: none; border-top: 1px solid #ccc;">
  <p style="color:#666; font-size: 12px;">
    Generado automáticamente por <code>auditDatosPrevisionales</code> en law-analytics-admin.
  </p>
</body>
</html>
`.trim();

	return { subject, textBody, htmlBody };
}

/**
 * Envía el reporte por email. Por defecto solo envía si hay warnings;
 * pasar `enviarSiOk: true` para recibir confirmación en cada corrida.
 */
async function enviarReporte(warnings, summary, opciones = {}) {
	const { destinatario = 'soporte@lawanalytics.app', enviarSiOk = false } = opciones;
	if (warnings.length === 0 && !enviarSiOk) {
		logger.info('[auditDatosPrevisionales] Sin warnings — no se envía email');
		return { success: true, emailEnviado: false };
	}
	const { subject, textBody, htmlBody } = construirEmail(warnings, summary);
	try {
		await sendEmail(destinatario, subject, htmlBody, textBody, []);
		logger.info(`[auditDatosPrevisionales] Email enviado a ${destinatario}`);
		return { success: true, emailEnviado: true };
	} catch (err) {
		logger.error(`[auditDatosPrevisionales] Error enviando email: ${err.message}`);
		return { success: false, emailEnviado: false, error: err.message };
	}
}

/**
 * Función registrable como cron. Solo corre si hoy es el último día del mes.
 * Si no, devuelve `{ skipped: true }` para que el log del taskService lo refleje.
 */
async function runAuditTask(opciones = {}) {
	if (!opciones.forzar && !esUltimoDiaDelMes()) {
		logger.info('[auditDatosPrevisionales] Hoy no es último día del mes — saltando');
		return { success: true, skipped: true, reason: 'no es último día del mes' };
	}

	try {
		const { warnings, summary } = await auditarCobertura();
		logger.info(
			`[auditDatosPrevisionales] Auditoría: ${summary.critical} críticos, ${summary.warning} warnings`,
		);
		const envio = await enviarReporte(warnings, summary, opciones);
		return { success: true, summary, warnings, emailEnviado: envio.emailEnviado };
	} catch (err) {
		logger.error(`[auditDatosPrevisionales] Error: ${err.message}`);
		return { success: false, error: err.message };
	}
}

module.exports = {
	auditarCobertura,
	construirEmail,
	enviarReporte,
	runAuditTask,
	esUltimoDiaDelMes,
};
