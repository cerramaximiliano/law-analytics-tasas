'use strict';
/**
 * Series de tasas que el BCRA publica solo en días hábiles como TNA en porcentaje
 * (BADLAR, TAMAR, TM20 de bancos privados). Se guardan en `Tasas` como valor diario
 * (TNA / 365) para que el motor del hub las sume como `interesDiario`.
 *
 * Relleno de días sin publicación:
 *  - Entre dos días publicados (fines de semana, feriados): se repite el último valor.
 *  - Después del último día publicado: solo sábado y domingo, y nunca más allá de `hasta`.
 *    Un día hábil sin dato puede ser un feriado o un dato que el BCRA todavía no publicó;
 *    se completa cuando llegue el siguiente día hábil.
 */

const moment = require('moment');

// tipoTasa → idVariable de la API v4 del BCRA (TNA, bancos privados)
const SERIES_TNA = {
	tasaBADLAR: { idVariable: '7', descripcion: 'Tasa BADLAR bancos privados (TNA)' },
	tasaTAMAR: { idVariable: '44', descripcion: 'Tasa TAMAR bancos privados (TNA)' },
	tasaTM20: { idVariable: '8', descripcion: 'Tasa TM20 bancos privados (TNA)' },
};

const FUENTE_PUBLICADO = 'BCRA API (TNA/365)';
const FUENTE_RELLENO = 'BCRA API (TNA/365, relleno día sin publicación)';

/**
 * @param {Array<{fecha:string, valor:number|string}>} datos  registros del BCRA (cualquier orden)
 * @param {{hasta?: string|Date}} opciones  último día que se puede completar (por defecto, hoy)
 * @returns {Array<{fecha:string, valor:number, tna:number, relleno:boolean}>} días corridos ordenados
 */
function expandirDiasHabiles(datos, opciones = {}) {
	const publicados = (datos || [])
		.filter((d) => d && d.fecha && d.valor !== undefined && d.valor !== null && !isNaN(parseFloat(d.valor)))
		.map((d) => ({ fecha: moment.utc(d.fecha, 'YYYY-MM-DD').startOf('day'), tna: parseFloat(d.valor) }))
		.sort((a, b) => a.fecha - b.fecha);
	if (!publicados.length) return [];

	const limite = moment.utc(opciones.hasta || undefined).startOf('day');
	const out = [];
	for (let i = 0; i < publicados.length; i++) {
		const actual = publicados[i];
		const siguiente = publicados[i + 1];
		out.push({ fecha: actual.fecha.format('YYYY-MM-DD'), tna: actual.tna, valor: actual.tna / 365, relleno: false });
		if (siguiente) {
			// Días entre dos publicaciones: repetir el último valor
			for (let d = actual.fecha.clone().add(1, 'day'); d.isBefore(siguiente.fecha); d.add(1, 'day')) {
				out.push({ fecha: d.format('YYYY-MM-DD'), tna: actual.tna, valor: actual.tna / 365, relleno: true });
			}
		} else {
			// Después del último publicado: solo el fin de semana inmediato
			for (let d = actual.fecha.clone().add(1, 'day'); !d.isAfter(limite); d.add(1, 'day')) {
				const dow = d.isoWeekday(); // 6 sábado, 7 domingo
				if (dow < 6) break;
				out.push({ fecha: d.format('YYYY-MM-DD'), tna: actual.tna, valor: actual.tna / 365, relleno: true });
			}
		}
	}
	return out;
}

module.exports = { SERIES_TNA, FUENTE_PUBLICADO, FUENTE_RELLENO, expandirDiasHabiles };
