/**
 * Estado de `datosprevisionales` para el reporte diario de tasas (utils/verificadorTasas.js): último mensual con
 * datos, mensuales pendientes a la fecha (y si el mes en curso está sin datos), completitud del salario mínimo y del
 * bono, y cómo viene corriendo el cron de sincronización con InfoLeg (documento `ultimo-aviso` de
 * `datosprevisionales-sincronizaciones`, que escribe runTareaSincronizacion en cada corrida).
 *
 * Niveles: 'alerta' (mes en curso o anteriores sin datos, el cron no corre hace más de 36 h, normas que no se leen),
 * 'aviso' (mes en curso sin salario mínimo o sin decreto de bono), 'ok'. El mes próximo sin datos es lo normal hasta
 * que ANSES publica (suele ser la última semana del mes): se informa como pendiente, sin alertar.
 */
const mongoose = require('mongoose');
const moment = require('moment-timezone');

const TZ = 'America/Argentina/Buenos_Aires';
const HORAS_SIN_CORRER = 36;

const mesSiguiente = (mes, n = 1) => moment.utc(mes, 'YYYY-MM').add(n, 'month').format('YYYY-MM');
const tieneDatos = (d) => d && d.movilidadGeneral > 0 && d.haberMinimoJubilacion > 0;

/**
 * @param {object} o
 * @param {object[]} o.docs - documentos de datosprevisionales (al menos los últimos meses)
 * @param {object} [o.aviso] - documento `ultimo-aviso` del cron
 * @param {Date} [o.ahora]
 */
function armarEstado({ docs, aviso, ahora = new Date() }) {
	const hoy = moment(ahora).tz(TZ);
	const mesCorriente = hoy.format('YYYY-MM');
	const mesProximo = mesSiguiente(mesCorriente);
	const porMes = Object.fromEntries(docs.map((d) => [moment.utc(d.fecha).format('YYYY-MM'), d]));
	const conDatos = Object.keys(porMes).filter((m) => tieneDatos(porMes[m])).sort();
	const ultimo = conDatos.pop() || null;

	const pendientes = [];
	for (let m = ultimo ? mesSiguiente(ultimo) : mesCorriente; m <= mesProximo; m = mesSiguiente(m)) {
		pendientes.push({ mes: m, estado: m < mesCorriente ? 'atrasado' : m === mesCorriente ? 'mes en curso sin datos' : 'pendiente de publicación' });
	}

	const faltantes = (m) => {
		const d = porMes[m];
		if (!tieneDatos(d)) return [];
		const f = [];
		if (!(d.salarioMVM > 0)) f.push('salario mínimo');
		if (!d.bonoNorma) f.push('decreto del bono');
		return f;
	};

	const problemas = [];
	const avisos = [];
	if (pendientes.some((p) => p.mes < mesCorriente)) problemas.push(`mensuales atrasados: ${pendientes.filter((p) => p.mes < mesCorriente).map((p) => p.mes).join(', ')}`);
	if (pendientes.some((p) => p.mes === mesCorriente)) problemas.push(`mes en curso ${mesCorriente} sin datos previsionales`);
	const faltaCorriente = faltantes(mesCorriente);
	if (faltaCorriente.length) avisos.push(`${mesCorriente} sin ${faltaCorriente.join(' ni ')}`);

	let cron = null;
	if (aviso && aviso.actualizado) {
		const horas = Math.round((ahora - new Date(aviso.actualizado)) / 36e5);
		cron = {
			ultimaCorrida: moment(aviso.actualizado).tz(TZ).format('YYYY-MM-DD HH:mm'),
			horas,
			corrida: aviso.ultimaCorrida || null,
			erroresParseo: (aviso.errores || []).length,
			erroresNormas: aviso.erroresNormas || [],
			conflictos: aviso.resumen ? aviso.resumen.conflictos || 0 : null,
			escritos: aviso.resumen ? aviso.resumen.escritos || 0 : null,
			smvmHasta: aviso.smvmHasta || null,
			ansesHasta: aviso.ansesHasta || null,
		};
		if (horas > HORAS_SIN_CORRER) problemas.push(`el cron de InfoLeg no corre hace ${horas} h`);
		if (cron.erroresParseo) problemas.push(`${cron.erroresParseo} normas de InfoLeg no se pudieron leer`);
	} else {
		avisos.push('sin registro de corridas del cron de InfoLeg');
	}

	const nivel = problemas.length ? 'alerta' : avisos.length ? 'aviso' : 'ok';
	const titular = problemas[0] || avisos[0] || `datos previsionales al día hasta ${ultimo}`;
	return {
		nivel, titular, problemas, avisos, hoy: hoy.format('YYYY-MM-DD'), mesCorriente, mesProximo,
		ultimo: ultimo ? { mes: ultimo, norma: porMes[ultimo].norma || null, movilidad: porMes[ultimo].movilidadGeneral, haberMinimo: porMes[ultimo].haberMinimoJubilacion, faltantes: faltantes(ultimo) } : null,
		pendientes, cron,
	};
}

async function obtenerEstadoDatosPrevisionales({ ahora = new Date() } = {}) {
	const db = mongoose.connection.db;
	const desde = moment.utc(ahora).startOf('month').subtract(12, 'months').toDate();
	const docs = await db.collection('datosprevisionales').find({ fecha: { $gte: desde } })
		.project({ fecha: 1, movilidadGeneral: 1, haberMinimoJubilacion: 1, norma: 1, salarioMVM: 1, bonoNorma: 1 }).toArray();
	const aviso = await db.collection('datosprevisionales-sincronizaciones').findOne({ _id: 'ultimo-aviso' });
	return armarEstado({ docs, aviso, ahora });
}

const COLOR = { alerta: '#d9534f', aviso: '#b8860b', ok: '#5cb85c' };
const pct = (m) => (m > 0 ? `${((m - 1) * 100).toFixed(2).replace('.', ',')} %` : '—');
const pesos = (n) => (n > 0 ? `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Filas [etiqueta, valor] comunes a la versión HTML y a la de texto. */
function filas(e) {
	const f = [];
	f.push(['Último mensual con datos', e.ultimo ? `${e.ultimo.mes} (${e.ultimo.norma || 'sin norma'}) · movilidad ${pct(e.ultimo.movilidad)} · haber mínimo ${pesos(e.ultimo.haberMinimo)}${e.ultimo.faltantes.length ? ` · falta ${e.ultimo.faltantes.join(' y ')}` : ''}` : 'ninguno']);
	f.push(['Mes en curso', e.pendientes.some((p) => p.mes === e.mesCorriente) ? `${e.mesCorriente}: SIN DATOS` : `${e.mesCorriente}: con datos`]);
	f.push(['Mensuales pendientes', e.pendientes.length ? e.pendientes.map((p) => `${p.mes} (${p.estado})`).join(', ') : 'ninguno']);
	if (e.cron) {
		f.push(['Última corrida del cron', `${e.cron.ultimaCorrida} (hace ${e.cron.horas} h)${e.cron.escritos ? ` · escribió ${e.cron.escritos} campos` : ''}`]);
		f.push(['Normas leídas en InfoLeg', `ANSES hasta ${e.cron.ansesHasta || '—'} · salario mínimo fijado hasta ${e.cron.smvmHasta || '—'}`]);
		f.push(['Errores de lectura / conflictos', `${e.cron.erroresParseo}${e.cron.erroresNormas.length ? ` (${e.cron.erroresNormas.join('; ')})` : ''} / ${e.cron.conflictos ?? '—'}`]);
	} else {
		f.push(['Cron de InfoLeg', 'sin registro de corridas']);
	}
	return f;
}

function htmlEstado(e) {
	if (!e || e.nivel === 'error') return `<h3>Datos previsionales</h3><p style="color:${COLOR.alerta}">No se pudo leer el estado: ${esc(e ? e.mensaje : 'sin datos')}</p>`;
	const lista = [...e.problemas, ...e.avisos];
	return `
          <h3>Datos previsionales (sincronización con InfoLeg)</h3>
          <p style="color:${COLOR[e.nivel]}; font-weight:bold">${esc(e.nivel === 'ok' ? `Al día: ${e.titular}` : lista.join(' · '))}</p>
          <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
            ${filas(e).map(([k, v]) => `<tr><td style="padding: 8px; width: 30%;"><strong>${esc(k)}</strong></td><td style="padding: 8px;">${esc(v)}</td></tr>`).join('\n            ')}
          </table>
          <p style="font-size: 12px; color: #666;">El mes próximo queda pendiente hasta que ANSES publica la resolución de movilidad (suele salir la última semana del mes). El cron corre todos los días a las 12:20 y 18:20.</p>`;
}

function textoEstado(e) {
	if (!e || e.nivel === 'error') return `DATOS PREVISIONALES: no se pudo leer el estado (${e ? e.mensaje : 'sin datos'})`;
	return ['DATOS PREVISIONALES', `Estado: ${e.nivel.toUpperCase()} · ${[...e.problemas, ...e.avisos].join(' · ') || e.titular}`, ...filas(e).map(([k, v]) => `- ${k}: ${v}`)].join('\n        ');
}

module.exports = { armarEstado, obtenerEstadoDatosPrevisionales, htmlEstado, textoEstado };
