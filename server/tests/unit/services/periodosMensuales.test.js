const assert = require('assert');
const { computarPeriodosMensuales } = require('../../../utils/periodosMensuales');
const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);

describe('periodosMensuales - computarPeriodosMensuales', () => {
	it('serie completa: rango de inicio de mes a fin de mes', () => {
		const r = computarPeriodosMensuales(['2026-01', '2026-02', '2026-03']);
		assert.strictEqual(iso(r.fechaInicio), '2026-01-01');
		assert.strictEqual(iso(r.fechaUltima), '2026-03-31');
		assert.strictEqual(iso(r.fechaUltimaCompleta), '2026-03-31');
		assert.deepStrictEqual(r.periodosFaltantes, []);
		assert.strictEqual(r.totalMeses, 3);
	});

	it('detecta meses faltantes y corta la última completa antes del primer hueco', () => {
		const r = computarPeriodosMensuales(['2026-03', '2025-12', '2026-01', '2026-04']);
		assert.deepStrictEqual(r.periodosFaltantes, ['2026-02']);
		assert.deepStrictEqual(r.fechasFaltantes.map(iso), ['2026-02-01']);
		assert.strictEqual(iso(r.fechaUltimaCompleta), '2026-01-31');
		assert.strictEqual(iso(r.fechaUltima), '2026-04-30');
	});

	it('febrero bisiesto como último mes', () => {
		assert.strictEqual(iso(computarPeriodosMensuales(['2024-02']).fechaUltima), '2024-02-29');
	});

	it('sin períodos válidos devuelve null', () => {
		assert.strictEqual(computarPeriodosMensuales(['x', '2026-1']), null);
	});
});

describe('indicesMensualesService - completarValoresVigentes', () => {
	const { completarValoresVigentes } = require('../../../services/scrapers/tasas/indicesMensualesService');
	it('repite el valor vigente en los meses sin cambio y marca el origen', () => {
		const r = completarValoresVigentes([
			{ periodo: '2026-04', valor: 300 },
			{ periodo: '2026-01', valor: 100 },
		]);
		assert.deepStrictEqual(r, [
			{ periodo: '2026-01', valor: 100 },
			{ periodo: '2026-02', valor: 100, rellenoDesde: '2026-01' },
			{ periodo: '2026-03', valor: 100, rellenoDesde: '2026-01' },
			{ periodo: '2026-04', valor: 300 },
		]);
	});
	it('sin datos devuelve vacío', () => {
		assert.deepStrictEqual(completarValoresVigentes([]), []);
	});
});
