'use strict';
/**
 * Seguimiento de índices y tasas en las tareas del admin (colección `admintasks`, vista
 * /admin/tasks del panel).
 *
 * Cada serie seguida tiene UNA tarea que vence cuando se espera su próximo dato:
 *   - series mensuales (IPC, RIPTE, inflación): vence el día en que el mes siguiente ya debería
 *     estar publicado. Cuando el cron lee ese mes, anota el valor como comentario y corre el
 *     vencimiento al mes que sigue.
 *   - tasas diarias (una sola tarea para todas): vence al día siguiente; la verificación de
 *     tasas la renueva mientras todas estén al día.
 *
 * Si el dato no llega, nadie corre el vencimiento y la tarea queda vencida a la vista: ese es el
 * aviso. No se crean tareas nuevas en cada ciclo; se reutiliza la misma (se ubica por
 * `metadata.seguimientoIndice`).
 *
 * Se escribe directo sobre la colección: el modelo AdminTask vive en law-analytics-server y este
 * servicio comparte la base, no el código. Los campos respetan ese esquema.
 */
const mongoose = require('mongoose');
const moment = require('moment');
const logger = require('../../utils/logger');
const { proximaPublicacion, mensualAlDia } = require('../../utils/calendarioPublicacion');

const AUTOR = 'law-analytics-tasas';
const MAX_COMENTARIOS = 60;
const num = (n) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 4 });
const dia = (d) => moment.utc(d).format('DD/MM/YYYY');

const coleccion = () => mongoose.connection.db.collection('admintasks');

/** Texto del comentario por un período nuevo o revisado. Función pura. */
function textoNovedad(descripcion, n) {
	if (n.tipo === 'revisado') return `${descripcion} ${n.periodo}: la fuente corrigió el valor, de ${num(n.anterior)} a ${num(n.valor)}.`;
	const variacion = Number.isFinite(n.variacion) ? ` (${n.variacion >= 0 ? '+' : ''}${n.variacion.toFixed(2).replace('.', ',')} % contra el mes anterior)` : '';
	return `${descripcion} ${n.periodo}: ${num(n.valor)}${variacion}. Fuente: ${n.fuente || 's/d'}.`;
}

/** Campos de la tarea de una serie mensual según su estado. Función pura. */
function planMensual({ serie, descripcion, fuente, regla, ultimoPeriodo, hoy = new Date() }) {
	const prox = proximaPublicacion(regla, ultimoPeriodo);
	const alDia = mensualAlDia(regla, ultimoPeriodo, hoy);
	return {
		clave: serie,
		title: `Seguimiento ${descripcion}: dato de ${prox.periodo}`,
		dueDate: prox.fecha,
		priority: alDia ? 'low' : 'high',
		description: [
			`Seguimiento automático de la serie mensual "${serie}" (${descripcion}).`,
			`Último mes cargado: ${ultimoPeriodo}. Próximo: ${prox.periodo}, que debería estar publicado el ${dia(prox.fecha)}.`,
			alDia ? 'Estado: al día.' : `Estado: ATRASADA — ${prox.periodo} ya debería estar cargado. Revisar la fuente y el cron "indices-mensuales".`,
			`Fuente: ${fuente || 's/d'}.`,
			'La tarea se renueva sola: cuando el servicio de tasas lee el mes esperado, lo anota como comentario y corre el vencimiento. Si queda vencida, el dato no llegó.',
		].join('\n'),
	};
}

async function guardar(plan, { comentarios = [], recurringPattern, aiSession } = {}) {
	const col = coleccion();
	const ahora = new Date();
	const filtro = { 'metadata.seguimientoIndice': plan.clave };
	const nuevos = comentarios.map((content) => ({ _id: new mongoose.Types.ObjectId(), content, createdBy: AUTOR, createdAt: ahora }));
	const existente = await col.findOne(filtro, { projection: { dueDate: 1, status: 1 } });
	// Un vencimiento nuevo abre un ciclo nuevo: la tarea vuelve a "por hacer" aunque se la haya cerrado.
	const cicloNuevo = !existente || !existente.dueDate || existente.dueDate.getTime() !== plan.dueDate.getTime();
	const set = { title: plan.title, description: plan.description, dueDate: plan.dueDate, priority: plan.priority, updatedAt: ahora };
	if (cicloNuevo) { set.status = 'todo'; set.progress = 0; }
	const update = {
		$set: set,
		$setOnInsert: {
			category: 'maintenance', project: 'tasas', tags: ['indices', 'seguimiento'], repos: ['law-analytics-tasas'],
			createdBy: AUTOR, assignedTo: null, isRecurring: true, recurringPattern, isPinned: false, isArchived: false,
			actualHours: 0, subtasks: [], attachments: [], relatedTasks: [], blockedBy: [], externalLinks: [],
			metadata: { seguimientoIndice: plan.clave }, createdAt: ahora,
			...(aiSession ? { aiContext: { agent: aiSession.agent || 'claude', sessions: [{ _id: new mongoose.Types.ObjectId(), agent: aiSession.agent || 'claude', sessionId: aiSession.sessionId, label: aiSession.label, createdAt: ahora }] } } : {}),
		},
		...(cicloNuevo ? { $unset: { completedAt: '' } } : {}),
		...(nuevos.length ? { $push: { comments: { $each: nuevos, $slice: -MAX_COMENTARIOS } } } : {}),
	};
	if (!nuevos.length) update.$setOnInsert.comments = [];
	await col.updateOne(filtro, update, { upsert: true });
	return { clave: plan.clave, creada: !existente, cicloNuevo, vence: plan.dueDate };
}

/**
 * Serie mensual: renueva su tarea con el último período cargado y anota las novedades.
 * Nunca voltea la actualización de la serie: si falla, se registra y sigue.
 */
async function seguirSerieMensual({ serie, descripcion, fuente, regla, ultimoPeriodo, novedades = [], aiSession }) {
	try {
		if (!regla || !ultimoPeriodo) return null;
		const plan = planMensual({ serie, descripcion, fuente, regla, ultimoPeriodo });
		// Una relectura completa puede traer muchas correcciones juntas: se resumen en un comentario.
		const comentarios = novedades.length > 6
			? [`${descripcion}: ${novedades.length} meses nuevos o corregidos por la fuente, de ${novedades[0].periodo} a ${novedades[novedades.length - 1].periodo} (detalle en el correo).`]
			: novedades.map((n) => textoNovedad(descripcion, n));
		return await guardar(plan, { comentarios, recurringPattern: 'monthly', aiSession });
	} catch (e) {
		logger.error(`seguimientoIndices: no se pudo actualizar la tarea de ${serie}: ${e.message}`);
		return null;
	}
}

/** Campos de la tarea de las tasas diarias. Función pura. */
function planDiario({ total, desactualizadas = [], hoy = new Date() }) {
	const alDia = desactualizadas.length === 0;
	const h = moment(hoy).format('YYYY-MM-DD');
	return {
		clave: 'tasas-diarias',
		title: 'Seguimiento tasas diarias (BCRA, BNA, CPACF)',
		// Al día: vence mañana a última hora. Con atrasos: no se corre, y queda vencida.
		dueDate: alDia ? moment.utc(h).add(1, 'day').endOf('day').milliseconds(0).toDate() : null,
		priority: alDia ? 'low' : 'high',
		description: [
			'Seguimiento automático de las series diarias del servicio de tasas.',
			`Último control: ${moment(hoy).format('DD/MM/YYYY HH:mm')} — ${total} series, ${alDia ? 'todas al día' : `${desactualizadas.length} ATRASADAS`}.`,
			...(alDia ? [] : desactualizadas.map((t) => `· ${t.tipoTasa}: último dato ${moment.utc(t.fechaUltima).format('DD/MM/YYYY')} (${t.diasDesdeUltimaActualizacion} días)`)),
			'La tarea se renueva sola cada día que la verificación encuentra todo al día. Si queda vencida, alguna serie dejó de actualizarse (el detalle llega también por correo).',
		].join('\n'),
	};
}

/** Tasas diarias: la verificación la llama con su resultado. */
async function seguirTasasDiarias({ resultado = [], aiSession } = {}) {
	try {
		const diarias = resultado.filter((t) => t.periodicidad !== 'mensual' && t.activa !== false);
		if (!diarias.length) return null;
		const plan = planDiario({ total: diarias.length, desactualizadas: diarias.filter((t) => !t.estaActualizada) });
		if (!plan.dueDate) {
			// Con atrasos solo se actualiza el texto; el vencimiento anterior queda como está.
			const r = await coleccion().updateOne({ 'metadata.seguimientoIndice': plan.clave }, { $set: { description: plan.description, priority: plan.priority, updatedAt: new Date() } });
			if (r.matchedCount) return { clave: plan.clave, renovada: false };
			plan.dueDate = moment.utc().startOf('day').toDate();
		}
		return await guardar(plan, { recurringPattern: 'daily', aiSession });
	} catch (e) {
		logger.error(`seguimientoIndices: no se pudo actualizar la tarea de tasas diarias: ${e.message}`);
		return null;
	}
}

module.exports = { seguirSerieMensual, seguirTasasDiarias, planMensual, planDiario, textoNovedad };
