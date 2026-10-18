const assert = require('assert');
const s = require('../../../services/scrapers/previsional/haberCajaActualizacionService');

describe('haberCajaActualizacion - fechas clave del haber de caja', () => {
	// 9/2026 → 10/2026 con los valores cargados (Res. ANSES 284/2026: movilidad 1,66 %; haber mínimo $ 435.748,51)
	const sep = {
		rentasAutonomos: { A: 187664.52, 'Cat.I': 240602.78 },
		pcPctPorAnio: 1.5,
		papPctPorAnio: 1.5,
		factorSuplementoAltas: 1,
		normas: { topePC: 'Res. SSS 6/09 art. 14', pcPctPorAnio: 'Ley 26.222' },
	};
	const oct = { haberMinimoJubilacion: 435748.51, movilidadGeneral: 1.0166, norma: 'Resolución 284/2026' };

	it('rentas de autónomos: la del mes anterior por la movilidad, al centavo (lo publicado en 10/2026)', () => {
		const { campos, normas } = s.calcularMes('2026-10', oct, sep);
		assert.deepStrictEqual(campos.rentasAutonomos, { A: 190779.75, 'Cat.I': 244596.79 });
		assert.strictEqual(normas.rentasAutonomos, 'Resolución 284/2026 (ANSES, movilidad mensual DNU 274/2024: 1.66 %)');
	});

	it('tope de la PC: 0,208 haberes mínimos al centavo; % de PC, PAP y factor del suplemento del mes anterior', () => {
		const { campos, normas } = s.calcularMes('2026-10', oct, sep);
		assert.strictEqual(campos.topePC, 90635.69);
		assert.strictEqual(normas.topePC, 'Res. SSS 6/09 art. 14');
		assert.deepStrictEqual([campos.pcPctPorAnio, campos.papPctPorAnio, campos.factorSuplementoAltas], [1.5, 1.5, 1]);
	});

	it('antes de 5/2024 las rentas no se derivan de la movilidad mensual', () => {
		const { campos } = s.calcularMes('2024-04', oct, sep);
		assert.strictEqual(campos.rentasAutonomos, undefined);
	});

	it('índice ley 27.260: trimestre = índice(m−3) × RIPTE(m−3)/RIPTE(m−6), provisorio; los demás meses repiten', () => {
		const indice = { '2026-09': { valor: 200, provisorio: false, norma: 'Disposición 10/2026' } };
		const ripte = { '2026-06': { valor: 1100 }, '2026-09': { valor: 1210 } };
		const oct26 = s.indiceLey27260('2026-10', indice, ripte);
		assert.deepStrictEqual([oct26.valor, oct26.provisorio], [200, false]);
		indice['2026-10'] = oct26;
		indice['2026-11'] = s.indiceLey27260('2026-11', indice, ripte);
		const dic = s.indiceLey27260('2026-12', indice, ripte);
		assert.ok(Math.abs(dic.valor - 220) < 1e-9);
		assert.strictEqual(dic.provisorio, true);
		assert.match(dic.norma, /RIPTE\(2026-09\) \/ RIPTE\(2026-06\)/);
	});

	it('disposición SSS: cubre el primer trimestre posterior a su fecha (5/2026 → 6/2026; 10/2026 → 9/2026)', () => {
		assert.strictEqual(s.trimestreDeDisposicion('2026-05-07'), '2026-06');
		assert.strictEqual(s.trimestreDeDisposicion('2026-08-10'), '2026-09');
		assert.strictEqual(s.trimestreDeDisposicion('2025-11-20'), '2025-12');
	});

	it('disposición SSS citada por ANSES confirma el trimestre provisorio y sus meses', () => {
		const indice = { '2026-12': { valor: 220, provisorio: true }, '2027-01': { valor: 220, provisorio: true }, '2026-09': { valor: 200, provisorio: false } };
		const c = s.confirmacionesLey27260(indice, [{ texto: 'Disposición 14/2026 SUBSECRETARIA DE SEGURIDAD SOCIAL (2026-11-09)', citadaEn: 'Resolución 330/2026' }]);
		assert.deepStrictEqual(c.map((x) => x.periodo), ['2026-12', '2027-01']);
		assert.match(c[0].norma, /^Disposición 14\/2026 SUBSECRETARIA DE SEGURIDAD SOCIAL, citada en la Resolución 330\/2026 de ANSES/);
		assert.deepStrictEqual(s.confirmacionesLey27260(indice, [{ texto: 'Disposición 10/2026 SUBSECRETARIA DE SEGURIDAD SOCIAL (2026-08-10)' }]), []);
	});

	it('índice ley 27.260: sin RIPTE del trimestre queda pendiente (null)', () => {
		assert.strictEqual(s.indiceLey27260('2026-12', { '2026-09': { valor: 200 } }, { '2026-06': { valor: 1100 } }), null);
	});
});
