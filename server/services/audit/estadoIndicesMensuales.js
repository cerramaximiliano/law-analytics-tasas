'use strict';
/**
 * Estado de los índices mensuales con calendario de publicación (IPC, RIPTE, inflación) para el
 * reporte diario de tasas: último mes cargado, mes que ya debería estar, cuándo se espera el
 * próximo y qué llegó o se corrigió en las últimas 24 horas. Va dentro del mismo correo que las
 * tasas y los datos previsionales; no hay un correo aparte.
 */
const moment = require('moment');
const { CATALOGO_TASAS } = require('../../utils/tasasIndices');
const { periodoEsperado, proximaPublicacion } = require('../../utils/calendarioPublicacion');

const VENTANA_HORAS = 24;
const num = (n) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 4 });
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')} %` : '—');
const dia = (d) => moment.utc(d).format('DD/MM/YYYY');

/**
 * Función pura.
 * @param {Array<{serie, descripcion, regla, tipo, ultimos:Array<{periodo,valor,fuente}>, novedades:Array}>} series
 *        `ultimos`: los dos últimos meses, del más viejo al más nuevo; `novedades`: documentos con novedad reciente.
 */
function armarEstadoIndices(series, ahora = new Date()) {
	const filas = series.filter((s) => s.ultimos && s.ultimos.length).map((s) => {
		const u = s.ultimos[s.ultimos.length - 1];
		const ant = s.ultimos.length > 1 ? s.ultimos[s.ultimos.length - 2] : null;
		const esperado = periodoEsperado(s.regla, ahora);
		const prox = proximaPublicacion(s.regla, u.periodo);
		return {
			serie: s.serie, descripcion: s.descripcion, ultimoPeriodo: u.periodo, valor: u.valor, fuente: u.fuente,
			variacion: s.tipo === 'nivel' && ant && ant.valor > 0 ? (u.valor / ant.valor - 1) * 100 : undefined,
			esperado, alDia: u.periodo >= esperado, proximo: prox,
			novedades: (s.novedades || []).map((n) => ({ periodo: n.periodo, tipo: n.novedadTipo, valor: n.valor, anterior: n.valorAnterior })),
		};
	});
	const atrasadas = filas.filter((f) => !f.alDia);
	const conNovedad = filas.filter((f) => f.novedades.length);
	const partes = [];
	for (const f of conNovedad) {
		const nuevo = f.novedades.filter((n) => n.tipo === 'nuevo').pop();
		partes.push(nuevo ? `${f.descripcion} ${nuevo.periodo}: ${num(nuevo.valor)}` : `${f.descripcion}: ${f.novedades.length} ${f.novedades.length > 1 ? 'meses corregidos' : 'mes corregido'}`);
	}
	for (const f of atrasadas) partes.push(`${f.descripcion} atrasado (falta ${f.esperado})`);
	return { nivel: atrasadas.length ? 'alerta' : 'ok', titular: partes.join(' · '), filas, atrasadas: atrasadas.length, novedades: conNovedad.length };
}

async function obtenerEstadoIndicesMensuales({ ahora = new Date() } = {}) {
	const IndicesMensuales = require('../../models/indicesMensuales');
	const { SERIES_MENSUALES } = require('../scrapers/tasas/indicesMensualesService');
	const desde = moment(ahora).subtract(VENTANA_HORAS, 'hours').toDate();
	const series = [];
	for (const [serie, cat] of Object.entries(CATALOGO_TASAS)) {
		if (!cat.publicacion) continue;
		const ultimos = (await IndicesMensuales.find({ serie }).sort({ periodo: -1 }).limit(2).select('periodo valor fuente').lean()).reverse();
		const novedades = await IndicesMensuales.find({ serie, novedadEn: { $gte: desde } }).sort({ periodo: 1 }).select('periodo valor novedadTipo valorAnterior').lean();
		series.push({ serie, descripcion: cat.descripcion, regla: cat.publicacion, tipo: (SERIES_MENSUALES[serie] || {}).tipo, ultimos, novedades });
	}
	return armarEstadoIndices(series, ahora);
}

function textoNovedades(f) {
	return f.novedades.slice(-12).map((n) => (n.tipo === 'nuevo' ? `${n.periodo} nuevo` : `${n.periodo} corregido (${num(n.anterior)} → ${num(n.valor)})`)).join('; ');
}

function htmlEstadoIndices(e) {
	if (!e || !e.filas || !e.filas.length) return '';
	const celda = 'padding: 8px;';
	const filas = e.filas.map((f) => `
          <tr>
            <td style="${celda}">${f.descripcion}</td>
            <td style="${celda} text-align: center;">${f.ultimoPeriodo}</td>
            <td style="${celda} text-align: right;">${num(f.valor)}${Number.isFinite(f.variacion) ? ` (${pct(f.variacion)})` : ''}</td>
            <td style="${celda} text-align: center; color: ${f.alDia ? 'green' : 'red'}; font-weight: ${f.alDia ? 'normal' : 'bold'};">${f.alDia ? 'Al día' : `Atrasado: falta ${f.esperado}`}</td>
            <td style="${celda} text-align: center;">${f.proximo.periodo}, el ${dia(f.proximo.fecha)}</td>
            <td style="${celda}${f.novedades.length ? ' color: #b45309; font-weight: bold;' : ''}">${f.novedades.length ? textoNovedades(f) : '—'}</td>
          </tr>`).join('');
	return `
        <h3>Índices mensuales</h3>
        <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
          <tr style="background-color: #f2f2f2;">
            <th style="text-align: left; ${celda}">Serie</th>
            <th style="${celda}">Último mes</th>
            <th style="${celda}">Valor (variación mensual)</th>
            <th style="${celda}">Estado</th>
            <th style="${celda}">Próximo dato</th>
            <th style="text-align: left; ${celda}">Novedades (últimas ${VENTANA_HORAS} h)</th>
          </tr>${filas}
        </table>`;
}

function textoEstadoIndices(e) {
	if (!e || !e.filas || !e.filas.length) return '';
	return ['ÍNDICES MENSUALES', ...e.filas.map((f) => `- ${f.descripcion}: ${f.ultimoPeriodo} = ${num(f.valor)}${Number.isFinite(f.variacion) ? ` (${pct(f.variacion)})` : ''} · ${f.alDia ? 'al día' : `ATRASADO, falta ${f.esperado}`} · próximo ${f.proximo.periodo} el ${dia(f.proximo.fecha)}${f.novedades.length ? ` · novedades: ${textoNovedades(f)}` : ''}`)].join('\n');
}

module.exports = { armarEstadoIndices, obtenerEstadoIndicesMensuales, htmlEstadoIndices, textoEstadoIndices };
