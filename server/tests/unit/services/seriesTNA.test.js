const assert = require('assert');
const { expandirDiasHabiles } = require('../../../services/scrapers/tasas/seriesTNA');

// Semana del 2026-10-05 (lunes) al 2026-10-11 (domingo). El 2026-10-12 es lunes.
const fechas = (r) => r.map((x) => x.fecha);

describe('seriesTNA - expandirDiasHabiles', () => {
	it('guarda TNA/365 por día', () => {
		const r = expandirDiasHabiles([{ fecha: '2026-10-06', valor: 36.5 }], { hasta: '2026-10-06' });
		assert.strictEqual(r.length, 1);
		assert.strictEqual(r[0].valor, 0.1);
		assert.strictEqual(r[0].relleno, false);
	});

	it('repite el viernes en sábado y domingo cuando hay un lunes publicado', () => {
		const r = expandirDiasHabiles(
			[
				{ fecha: '2026-10-12', valor: 30 },
				{ fecha: '2026-10-09', valor: 36.5 },
			],
			{ hasta: '2026-10-12' }
		);
		assert.deepStrictEqual(fechas(r), ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
		assert.deepStrictEqual(r.map((x) => x.relleno), [false, true, true, false]);
		assert.strictEqual(r[2].valor, 0.1);
	});

	it('completa un feriado entre dos días publicados', () => {
		// miércoles 7 sin publicación (feriado)
		const r = expandirDiasHabiles(
			[
				{ fecha: '2026-10-06', valor: 36.5 },
				{ fecha: '2026-10-08', valor: 73 },
			],
			{ hasta: '2026-10-08' }
		);
		assert.deepStrictEqual(fechas(r), ['2026-10-06', '2026-10-07', '2026-10-08']);
		assert.strictEqual(r[1].valor, 0.1);
		assert.strictEqual(r[1].relleno, true);
	});

	it('al final solo completa el fin de semana, no un día hábil sin publicar', () => {
		// último publicado: jueves 8; hasta: martes 13
		const r = expandirDiasHabiles([{ fecha: '2026-10-08', valor: 36.5 }], { hasta: '2026-10-13' });
		assert.deepStrictEqual(fechas(r), ['2026-10-08']); // el viernes 9 no se inventa
		const r2 = expandirDiasHabiles([{ fecha: '2026-10-09', valor: 36.5 }], { hasta: '2026-10-13' });
		assert.deepStrictEqual(fechas(r2), ['2026-10-09', '2026-10-10', '2026-10-11']);
	});

	it('no completa más allá de "hasta"', () => {
		const r = expandirDiasHabiles([{ fecha: '2026-10-09', valor: 36.5 }], { hasta: '2026-10-10' });
		assert.deepStrictEqual(fechas(r), ['2026-10-09', '2026-10-10']);
	});

	it('ignora registros inválidos y devuelve vacío sin datos', () => {
		assert.deepStrictEqual(expandirDiasHabiles([]), []);
		const r = expandirDiasHabiles([{ fecha: '2026-10-06', valor: 'x' }, { fecha: '2026-10-07', valor: 36.5 }], { hasta: '2026-10-07' });
		assert.deepStrictEqual(fechas(r), ['2026-10-07']);
	});
});
