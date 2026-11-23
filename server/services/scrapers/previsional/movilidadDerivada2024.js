'use strict';
/**
 * Coeficientes de movilidad DERIVADOS de IPC y RIPTE que usan dos criterios del retroactivo previsional del hub
 * para el empalme de 2024 (law-analytics-server, `services/previsionalService.js`). No son una fuente: se calculan
 * con las series oficiales de `indicesmensuales` (`ipc` del INDEC, `ripte` de la Secretaría de Trabajo).
 *
 *  - `movilidadEmpalme27426Dnu` (2024-07): empalme de la ley 27.426 con el DNU 274/24, 70 % de la variación del IPC
 *    + 30 % de la del RIPTE de diciembre de 2023 a abril de 2024. CFSS Sala II, "Galletta" (13/11/2026), en la
 *    lectura que BlueCorp ofrece como "con empalme 70/30 ene-abr 2024" (su índice 207).
 *  - `movilidadAguirreIpcTrimestral` (2024-03 y 2024-06): IPC de octubre–diciembre de 2023 y de enero–marzo de 2024.
 *    CFSS Sala III, "Aguirre" (5/11/2026), y mayoría de "Pena" (Sala I, 17/11/2026); índice 202 de BlueCorp.
 *
 * Referencia de calibración: los coeficientes que resultan de las grillas de haberes de BlueCorp del 23/11/2026
 * (caso inventado MOLINA, la-research/herramientas/bluecorp/pruebas/2026-11-23-molina/variantes.json).
 */
const r8 = (x) => Math.round(x * 1e8) / 1e8;

const REFERENCIA_BLUECORP = {
	// 547.489,38 / 316.059,341 / 1,0418 (aumento general de julio)
	'2024-07': { campo: 'movilidadEmpalme27426Dnu', valor: 1.66273376 },
	// 244.192,261 / 159.302,00 (haber de 12/2023 sin el bono)
	'2024-03': { campo: 'movilidadAguirreIpcTrimestral', valor: 1.53288886 },
	// 370.248,93 / 244.192,261
	'2024-06': { campo: 'movilidadAguirreIpcTrimestral', valor: 1.51621894 },
};
const TOLERANCIA = 1e-6;

/**
 * @param {Object<string, number>} ipc   nivel del IPC por período (YYYY-MM)
 * @param {Object<string, number>} ripte nivel del RIPTE por período
 * @returns {Array<{periodo, campo, valor, formula}>}
 */
function calcularCoeficientes(ipc, ripte) {
	const pide = (serie, nombre, p) => {
		if (!(serie[p] > 0)) throw new Error(`falta ${nombre} ${p} en indicesmensuales`);
		return serie[p];
	};
	const vIpc = (a, b) => pide(ipc, 'ipc', b) / pide(ipc, 'ipc', a);
	const vRipte = (a, b) => pide(ripte, 'ripte', b) / pide(ripte, 'ripte', a);
	return [
		{ periodo: '2024-03', campo: 'movilidadAguirreIpcTrimestral', valor: r8(vIpc('2023-09', '2023-12')), formula: 'IPC 12/2023 ÷ IPC 9/2023' },
		{ periodo: '2024-06', campo: 'movilidadAguirreIpcTrimestral', valor: r8(vIpc('2023-12', '2024-03')), formula: 'IPC 3/2024 ÷ IPC 12/2023' },
		{
			periodo: '2024-07', campo: 'movilidadEmpalme27426Dnu',
			valor: r8(1 + 0.7 * (vIpc('2023-12', '2024-04') - 1) + 0.3 * (vRipte('2023-12', '2024-04') - 1)),
			formula: '1 + 70 % var. IPC + 30 % var. RIPTE, 12/2023 a 4/2024',
		},
	];
}

/** Compara con BlueCorp. @returns {Array<{periodo, campo, valor, referencia, diferencia, ok}>} */
function calibrar(coeficientes) {
	return coeficientes.map((c) => {
		const ref = REFERENCIA_BLUECORP[c.periodo];
		const diferencia = Math.abs(c.valor - ref.valor);
		return { ...c, referencia: ref.valor, diferencia, ok: ref.campo === c.campo && diferencia <= TOLERANCIA };
	});
}

module.exports = { calcularCoeficientes, calibrar, REFERENCIA_BLUECORP, TOLERANCIA };
