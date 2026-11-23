'use strict';
const moment = require('moment');

/**
 * Calendario de publicación de las series mensuales.
 *
 * Una regla `{ mesesDespues, dia }` dice que el dato del mes M ya tiene que estar publicado el
 * día `dia` del mes M + `mesesDespues`. Ejemplo, IPC `{ mesesDespues: 1, dia: 18 }`: el IPC de
 * octubre se espera desde el 18 de noviembre. Con eso una serie está "al día" si llega al
 * período esperado, y su próximo vencimiento es la fecha en que se espera el mes siguiente.
 *
 * Reemplaza, para las series mensuales, el margen fijo en días (`atrasoPublicacionDias`), que
 * dejaba pasar semanas de atraso real antes de avisar.
 */

const sumarMeses = (periodo, n) => moment.utc(periodo, 'YYYY-MM').add(n, 'months').format('YYYY-MM');

/** Fecha (UTC, 00:00) desde la cual el período debe estar publicado. */
function fechaEsperada(regla, periodo) {
	const m = moment.utc(sumarMeses(periodo, regla.mesesDespues), 'YYYY-MM');
	return m.date(Math.min(regla.dia, m.daysInMonth())).toDate();
}

/** Último período que ya debería estar publicado a la fecha `hoy` (YYYY-MM). */
function periodoEsperado(regla, hoy = new Date()) {
	const h = moment.utc(moment(hoy).format('YYYY-MM-DD'), 'YYYY-MM-DD');
	let p = sumarMeses(h.format('YYYY-MM'), -regla.mesesDespues);
	if (h.isBefore(moment.utc(fechaEsperada(regla, p)))) p = sumarMeses(p, -1);
	return p;
}

/** ¿La serie, que llega hasta `ultimoPeriodo`, está al día a la fecha `hoy`? */
function mensualAlDia(regla, ultimoPeriodo, hoy = new Date()) {
	return Boolean(ultimoPeriodo) && ultimoPeriodo >= periodoEsperado(regla, hoy);
}

/** Próximo dato a esperar: el mes siguiente al último publicado y la fecha en que vence. */
function proximaPublicacion(regla, ultimoPeriodo) {
	const periodo = sumarMeses(ultimoPeriodo, 1);
	return { periodo, fecha: fechaEsperada(regla, periodo) };
}

module.exports = { fechaEsperada, periodoEsperado, mensualAlDia, proximaPublicacion, sumarMeses };
