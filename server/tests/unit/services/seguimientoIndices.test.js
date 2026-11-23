const assert = require('assert');
const { periodoEsperado, mensualAlDia, proximaPublicacion, fechaEsperada } = require('../../../utils/calendarioPublicacion');
const { CATALOGO_TASAS, serieAlDia } = require('../../../utils/tasasIndices');
const { detectarNovedades } = require('../../../services/scrapers/tasas/indicesMensualesService');
const { armarEstadoIndices, htmlEstadoIndices, textoEstadoIndices } = require('../../../services/audit/estadoIndicesMensuales');
const { asuntoReporte } = require('../../../utils/verificadorTasas');
const { planMensual, planDiario, textoNovedad } = require('../../../services/seguimiento/seguimientoIndices');

const iso = (d) => d.toISOString().slice(0, 10);
const IPC = CATALOGO_TASAS.ipc.publicacion;
const RIPTE = CATALOGO_TASAS.ripte.publicacion;

describe('calendario de publicación de las series mensuales', () => {
	it('IPC: el mes anterior se espera desde el 18', () => {
		assert.strictEqual(periodoEsperado(IPC, new Date('2026-11-17T15:00:00Z')), '2026-09');
		assert.strictEqual(periodoEsperado(IPC, new Date('2026-11-18T15:00:00Z')), '2026-10');
		assert.strictEqual(periodoEsperado(IPC, new Date('2027-01-05T15:00:00Z')), '2026-11');
	});

	it('RIPTE: sale a mediados del segundo mes siguiente', () => {
		assert.strictEqual(periodoEsperado(RIPTE, new Date('2026-11-23T15:00:00Z')), '2026-09');
		assert.strictEqual(periodoEsperado(RIPTE, new Date('2026-11-19T15:00:00Z')), '2026-08');
	});

	it('el caso del 23/11/2026: IPC a octubre está al día; RIPTE a agosto, atrasado', () => {
		const hoy = new Date('2026-11-23T15:00:00Z');
		assert.strictEqual(mensualAlDia(IPC, '2026-10', hoy), true);
		assert.strictEqual(mensualAlDia(RIPTE, '2026-08', hoy), false);
		assert.strictEqual(mensualAlDia(RIPTE, '2026-09', hoy), true);
		// Con el margen fijo anterior (110 días desde el 31/8) el atraso del RIPTE no se veía
		assert.strictEqual(serieAlDia({ tipoTasa: 'ripte', ultimoPeriodo: '2026-08', fechaUltima: new Date('2026-08-31'), atrasoPublicacionDias: 110 }, hoy), false);
	});

	it('series sin calendario siguen por días de atraso', () => {
		const hoy = new Date('2026-11-23T15:00:00Z');
		assert.strictEqual(serieAlDia({ tipoTasa: 'tasaPasivaBNA', fechaUltima: new Date('2026-11-23'), atrasoPublicacionDias: 0 }, hoy), true);
		assert.strictEqual(serieAlDia({ tipoTasa: 'tasaPasivaBNA', fechaUltima: new Date('2026-11-21'), atrasoPublicacionDias: 0 }, hoy), false);
		assert.strictEqual(serieAlDia({ tipoTasa: 'tasaBADLAR', fechaUltima: new Date('2026-11-19'), atrasoPublicacionDias: 6 }, hoy), true);
	});

	it('próximo vencimiento: el mes siguiente al último cargado', () => {
		const p = proximaPublicacion(IPC, '2026-10');
		assert.strictEqual(p.periodo, '2026-11');
		assert.strictEqual(iso(p.fecha), '2026-12-18');
		assert.strictEqual(iso(proximaPublicacion(RIPTE, '2026-09').fecha), '2026-12-20');
		assert.strictEqual(iso(fechaEsperada({ mesesDespues: 1, dia: 31 }, '2027-01')), '2027-02-28');
	});
});

describe('novedades de una serie mensual', () => {
	const leidos = [
		{ periodo: '2026-07', valor: 1946028.12 },
		{ periodo: '2026-08', valor: 1982518.19, fuente: 'oficial' },
		{ periodo: '2026-09', valor: 2022244.09, fuente: 'oficial' },
	];
	const previos = new Map([['2026-07', 1946028.12], ['2026-08', 1915878.76]]);

	it('distingue el mes nuevo (con su variación) del mes corregido', () => {
		const n = detectarNovedades(leidos, previos, 'nivel', 'datos.gob.ar');
		assert.strictEqual(n.length, 2);
		assert.deepStrictEqual({ ...n[0] }, { tipo: 'revisado', periodo: '2026-08', valor: 1982518.19, anterior: 1915878.76, fuente: 'oficial' });
		assert.strictEqual(n[1].tipo, 'nuevo');
		assert.strictEqual(n[1].periodo, '2026-09');
		assert.strictEqual(n[1].variacion.toFixed(2), '2.00');
	});

	it('sin cambios no hay novedades; la carga inicial tampoco avisa', () => {
		assert.deepStrictEqual(detectarNovedades(leidos.slice(0, 1), previos, 'nivel'), []);
		assert.deepStrictEqual(detectarNovedades(leidos, new Map(), 'nivel'), []);
	});

	it('un mes viejo que se completa en una relectura no es novedad', () => {
		const n = detectarNovedades([{ periodo: '1943-02', valor: -0.6 }, { periodo: '1943-03', valor: 0.4 }], new Map([['1943-03', 0.4]]), 'variacion');
		assert.deepStrictEqual(n, []);
	});

	it('una serie de variación no calcula variación sobre la variación', () => {
		const n = detectarNovedades([{ periodo: '2026-09', valor: 2.1 }, { periodo: '2026-10', valor: 2.3 }], new Map([['2026-09', 2.1]]), 'variacion');
		assert.strictEqual(n[0].variacion, undefined);
	});

	it('el reporte diario lleva los índices: novedad del día en el asunto, atraso como alerta', () => {
		const ahora = new Date('2026-11-23T21:00:00Z');
		const e = armarEstadoIndices([
			{ serie: 'ripte', descripcion: 'RIPTE', regla: RIPTE, tipo: 'nivel', ultimos: leidos.slice(1), novedades: [{ periodo: '2026-08', novedadTipo: 'revisado', valor: 1982518.19, valorAnterior: 1915878.76 }, { periodo: '2026-09', novedadTipo: 'nuevo', valor: 2022244.09 }] },
			{ serie: 'ipc', descripcion: 'IPC', regla: IPC, tipo: 'nivel', ultimos: [{ periodo: '2026-09', valor: 12514.1508 }, { periodo: '2026-10', valor: 12785.9321 }], novedades: [] },
		], ahora);
		assert.strictEqual(e.nivel, 'ok');
		assert.strictEqual(e.titular, 'RIPTE 2026-09: 2.022.244,09');
		assert.strictEqual(e.filas[0].variacion.toFixed(2), '2.00');
		assert.strictEqual(e.filas[1].proximo.periodo, '2026-11');
		const asunto = asuntoReporte({ previsional: { nivel: 'ok', titular: 'previsional al día' }, indices: e, fechaActual: ahora });
		assert.ok(asunto.startsWith('[OK]') && asunto.includes('RIPTE 2026-09'));
		assert.ok(htmlEstadoIndices(e).includes('2026-08 corregido') && textoEstadoIndices(e).includes('próximo 2026-11 el 18/12/2026'));
		// sin novedades el asunto no cambia
		const quieto = armarEstadoIndices([{ serie: 'ipc', descripcion: 'IPC', regla: IPC, tipo: 'nivel', ultimos: [{ periodo: '2026-10', valor: 1 }], novedades: [] }], ahora);
		assert.ok(!asuntoReporte({ previsional: { nivel: 'ok', titular: 'x' }, indices: quieto, fechaActual: ahora }).includes('IPC'));
		// atrasado
		const mal = armarEstadoIndices([{ serie: 'ripte', descripcion: 'RIPTE', regla: RIPTE, tipo: 'nivel', ultimos: leidos.slice(0, 2), novedades: [] }], ahora);
		assert.strictEqual(mal.nivel, 'alerta');
		assert.ok(textoEstadoIndices(mal).includes('ATRASADO, falta 2026-09'));
	});
});

describe('tareas de seguimiento', () => {
	it('serie al día: vence cuando se espera el mes siguiente, prioridad baja', () => {
		const p = planMensual({ serie: 'ipc', descripcion: 'IPC INDEC', fuente: 'INDEC', regla: IPC, ultimoPeriodo: '2026-10', hoy: new Date('2026-11-23T15:00:00Z') });
		assert.strictEqual(iso(p.dueDate), '2026-12-18');
		assert.strictEqual(p.priority, 'low');
		assert.ok(p.title.includes('2026-11') && p.description.includes('al día'));
	});

	it('serie atrasada: la tarea ya está vencida y sube de prioridad', () => {
		const hoy = new Date('2026-11-23T15:00:00Z');
		const p = planMensual({ serie: 'ripte', descripcion: 'RIPTE', regla: RIPTE, ultimoPeriodo: '2026-08', hoy });
		assert.strictEqual(iso(p.dueDate), '2026-11-20');
		assert.ok(p.dueDate < hoy);
		assert.strictEqual(p.priority, 'high');
		assert.ok(p.description.includes('ATRASADA'));
	});

	it('tasas diarias: al día vence mañana; con atrasos no corre el vencimiento', () => {
		const hoy = new Date(2026, 10, 23, 9, 0, 0);
		const ok = planDiario({ total: 20, hoy });
		assert.strictEqual(iso(ok.dueDate), '2026-11-24');
		const mal = planDiario({ total: 20, hoy, desactualizadas: [{ tipoTasa: 'cer', fechaUltima: new Date('2026-11-20'), diasDesdeUltimaActualizacion: 3 }] });
		assert.strictEqual(mal.dueDate, null);
		assert.ok(mal.description.includes('cer') && mal.priority === 'high');
	});

	it('comentario de un mes nuevo y de uno corregido', () => {
		assert.ok(textoNovedad('RIPTE', { tipo: 'nuevo', periodo: '2026-09', valor: 2022244.09, variacion: 2.0038, fuente: 'oficial' }).includes('+2,00 % contra el mes anterior'));
		assert.ok(textoNovedad('RIPTE', { tipo: 'revisado', periodo: '2026-08', valor: 1982518.19, anterior: 1915878.76 }).includes('corrigió'));
	});
});
