'use strict';
const moment = require('moment');

/**
 * Rango y huecos de una serie mensual a partir de sus períodos publicados (YYYY-MM).
 * Las fechas siguen la convención de TasasConfig para que la UI las use igual que en las
 * series diarias: inicio = día 1 del primer mes, última = último día del último mes, faltantes =
 * día 1 de cada mes sin dato, última completa = último día del mes previo al primer hueco.
 */
function computarPeriodosMensuales(periodos) {
	const unicos = [...new Set((periodos || []).filter((p) => /^\d{4}-\d{2}$/.test(p)))].sort();
	if (!unicos.length) return null;
	const presentes = new Set(unicos);
	const primero = unicos[0];
	const ultimo = unicos[unicos.length - 1];
	const faltantes = [];
	for (let m = moment.utc(primero, 'YYYY-MM'); m.format('YYYY-MM') <= ultimo; m.add(1, 'month')) {
		if (!presentes.has(m.format('YYYY-MM'))) faltantes.push(m.format('YYYY-MM'));
	}
	const finDeMes = (p) => moment.utc(p, 'YYYY-MM').endOf('month').startOf('day').toDate();
	const inicioDeMes = (p) => moment.utc(p, 'YYYY-MM').startOf('month').toDate();
	let ultimaCompleta = finDeMes(ultimo);
	if (faltantes.length) {
		const previo = moment.utc(faltantes[0], 'YYYY-MM').subtract(1, 'month').format('YYYY-MM');
		ultimaCompleta = previo >= primero ? finDeMes(previo) : null;
	}
	const totalMeses = moment.utc(ultimo, 'YYYY-MM').diff(moment.utc(primero, 'YYYY-MM'), 'months') + 1;
	return {
		primero,
		ultimo,
		fechaInicio: inicioDeMes(primero),
		fechaUltima: finDeMes(ultimo),
		fechaUltimaCompleta: ultimaCompleta,
		fechasFaltantes: faltantes.map(inicioDeMes),
		periodosFaltantes: faltantes,
		totalMeses,
	};
}

module.exports = { computarPeriodosMensuales };
