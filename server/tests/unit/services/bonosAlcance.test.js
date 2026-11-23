const assert = require('assert');
const fs = require('fs');
const path = require('path');
const b = require('../../../services/scrapers/previsional/bonosAlcance');
const s = require('../../../services/scrapers/previsional/datosPrevisionalesService');

const fixture = (f) => fs.readFileSync(path.join(__dirname, '../../fixtures/previsional', f)).toString('latin1');

describe('bonosAlcance - pagos únicos 2004-2016', () => {
	it('son siete, uno por mes, con alcance válido y URL de InfoLeg', () => {
		assert.deepStrictEqual(b.PAGOS_UNICOS.map((p) => p.mes), ['2004-12', '2008-12', '2009-12', '2010-12', '2015-12', '2016-04', '2016-12']);
		for (const p of b.PAGOS_UNICOS) {
			assert.ok(p.id > 0 && /^Decreto \d+\/\d{4}$/.test(p.norma));
			for (const e of p.escalones) assert.ok(b.ALCANCES.includes(e.alcance) && e.monto > 0);
			assert.strictEqual(Math.max(...p.escalones.map((e) => e.monto)), p.bono);
		}
	});

	it('un mes sin bono recibe el pago único con norma, alcance y fuente', () => {
		const p = b.planMes('2009-12', { haberMinimoJubilacion: 827.23 });
		assert.strictEqual(p.tipo, 'pago_unico');
		assert.strictEqual(p.set.bono, 350);
		assert.strictEqual(p.set.bonoEscalones.length, 7);
		assert.deepStrictEqual(p.set.bonoEscalones[0], { hasta: 827.23, monto: 350, norma: 'Decreto 1879/2009', alcance: 'escalonado', base: 'cada_prestacion', universo: 'sipa', excluye: [b.POLICIA], url: `${b.INFOLEG}161043` });
		assert.deepStrictEqual(p.set['fuentes.bono'], [`${b.INFOLEG}161043`]);
		const d2004 = b.planMes('2004-12', {}).set.bonoEscalones;
		assert.deepStrictEqual(d2004, [{ hasta: null, monto: 200, norma: 'Decreto 1670/2004', alcance: 'todos', base: 'suma_prestaciones', universo: 'sipa', url: `${b.INFOLEG}101520` }]);
	});

	it('es idempotente y no pisa un bono distinto ya cargado', () => {
		const set = b.planMes('2015-12', {}).set;
		assert.strictEqual(b.planMes('2015-12', { bono: set.bono, bonoEscalones: set.bonoEscalones }), null);
		const otro = b.planMes('2015-12', { bono: 999, bonoEscalones: [{ hasta: null, monto: 999, norma: 'X' }] });
		assert.ok(/no se pisa/.test(otro.problema));
		assert.ok(/no hay documento/.test(b.planMes('2015-12', null).problema));
	});
});

describe('bonosAlcance - decretos ya cargados (12/2019 en adelante)', () => {
	it('agrega alcance, base, universo y URL sin tocar hasta, monto ni norma', () => {
		const doc = { bonoNorma: 'Decreto 481/2021 (subsidio extraordinario)', bonoEscalones: [{ hasta: 46129.4, monto: 5000, norma: 'Decreto 481/2021' }], fuentes: { bono: ['http://x/352317'] } };
		const p = b.planMes('2021-08', doc);
		assert.strictEqual(p.tipo, 'alcance');
		assert.deepStrictEqual(p.set, { bonoEscalones: [{ hasta: 46129.4, monto: 5000, norma: 'Decreto 481/2021', alcance: 'umbral_decreciente', base: 'suma_prestaciones', universo: 'sipa', excluye: [b.POLICIA], url: 'http://x/352317' }] });
		assert.strictEqual(b.planMes('2021-08', { ...doc, bonoEscalones: p.set.bonoEscalones }), null);
	});

	it('base y universo cambian con los decretos: único beneficio (2019-2020), suma (2021), art. 32 (desde 9/2022)', () => {
		assert.strictEqual(b.clasificacionVigente('2020-04').base, 'unico_beneficio');
		assert.strictEqual(b.clasificacionVigente('2022-05').universo, 'sipa');
		assert.deepStrictEqual(b.clasificacionVigente('2022-09'), { alcance: 'umbral_decreciente', base: 'suma_prestaciones', universo: 'movilidad_art32' });
		assert.strictEqual(b.clasificacionVigente('2016-12'), null);
	});

	it('4/2024 anota el Dec. 282/2024 como norma modificatoria', () => {
		const doc = { bonoNorma: 'Decreto 268/2024 (bono extraordinario previsional)', bonoEscalones: [{ hasta: null, monto: 70000, norma: 'Decreto 268/2024' }] };
		const p = b.planMes('2024-04', doc);
		assert.strictEqual(p.set.bonoEscalones[0].normaModificatoria, 'Decreto 282/2024');
		assert.strictEqual(p.set.bonoEscalones[0].hasta, null);
		assert.ok(p.set.bonoNorma.endsWith('umbral sustituido por el Decreto 282/2024'));
	});

	it('un mes sin bono o anterior a 12/2019 no se toca', () => {
		assert.strictEqual(b.planMes('2021-09', { bonoEscalones: [] }), null);
		assert.strictEqual(b.planMes('2018-03', { bonoEscalones: [{ hasta: null, monto: 1, norma: 'X' }] }), null);
	});

	it('revertir deja los documentos como estaban', () => {
		const doc = { bonoNorma: 'Decreto 268/2024 (bono extraordinario previsional)', bonoEscalones: [{ hasta: null, monto: 70000, norma: 'Decreto 268/2024' }] };
		const p = b.planMes('2024-04', doc);
		const r = b.planRevertir('2024-04', { ...doc, ...p.set });
		assert.deepStrictEqual(r.set, { bonoEscalones: doc.bonoEscalones, bonoNorma: doc.bonoNorma });
		assert.strictEqual(b.planRevertir('2024-04', doc), null);
		const unico = b.planMes('2010-12', {}).set;
		assert.deepStrictEqual(Object.keys(b.planRevertir('2010-12', { bonoEscalones: unico.bonoEscalones }).unset), ['bono', 'bonoNorma', 'bonoEscalones', 'fuentes.bono']);
		assert.strictEqual(b.planRevertir('2010-12', {}), null);
	});
});

describe('bonosAlcance - clasificación por texto (sincronizador)', () => {
	it('Dec. 309/2020: único beneficio, SIPA, excluye policía provincial transferida', () => {
		const r = s.parsearDecretoBono(fixture('bono-dec-309-2020.htm'));
		assert.deepStrictEqual(r.clasificacion, { alcance: 'umbral_decreciente', base: 'unico_beneficio', universo: 'sipa', excluye: [b.POLICIA] });
	});
	it('Dec. 215/2022: suma de prestaciones, SIPA', () => {
		const c = s.parsearDecretoBono(fixture('bono-dec-215-2022.htm')).clasificacion;
		assert.strictEqual(c.base, 'suma_prestaciones');
		assert.strictEqual(c.universo, 'sipa');
	});
	it('Dec. 268/2024: suma de prestaciones y solo movilidad del art. 32', () => {
		const c = s.parsearDecretoBono(fixture('bono-dec-268-2024.htm')).clasificacion;
		assert.deepStrictEqual(c, { alcance: 'umbral_decreciente', base: 'suma_prestaciones', universo: 'movilidad_art32' });
	});
	it('las anotaciones de alcance no hacen conflicto con un mes ya cargado', () => {
		const existente = { bonoEscalones: [{ hasta: null, monto: 70000, norma: 'Decreto 1/2026', alcance: 'umbral_decreciente', base: 'suma_prestaciones', url: 'u' }] };
		const cambios = s.diffMes(existente, { bonoEscalones: [{ hasta: null, monto: 70000, norma: 'Decreto 1/2026' }] });
		assert.strictEqual(cambios[0].estado, 'igual');
		assert.strictEqual(s.diffMes(existente, { bonoEscalones: [{ hasta: null, monto: 80000, norma: 'Decreto 1/2026' }] })[0].estado, 'conflicto');
	});
});
