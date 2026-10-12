const assert = require('assert');
const fs = require('fs');
const path = require('path');
const s = require('../../../services/scrapers/previsional/datosPrevisionalesService');

// HTML de InfoLeg guardado tal cual (ISO-8859-1)
const fixture = (f) => fs.readFileSync(path.join(__dirname, '../../fixtures/previsional', f)).toString('latin1');

describe('datosPrevisionales - parseo de resoluciones de ANSES', () => {
	it('Res. 139/2026: junio 2026, 2,58 %, los cinco artículos', () => {
		const r = s.parsearResolucionAnses(fixture('anses-res-139-2026.htm'));
		assert.strictEqual(r.norma, 'Resolución 139/2026');
		assert.strictEqual(r.mes, '2026-06');
		assert.strictEqual(r.movilidadPct, 2.58);
		assert.strictEqual(r.haberMinimo, 403317.99);
		assert.strictEqual(r.haberMaximo, 2713948.17);
		assert.strictEqual(r.baseImponibleMinima, 135837.4);
		assert.strictEqual(r.baseImponibleMaxima, 4414652.38);
		assert.strictEqual(r.pbu, 184499.57);
		assert.strictEqual(r.puam, 322654.39);
		assert.deepStrictEqual(r.errores, []);
	});

	it('Res. 284/2026 (redacción "resultando éste del"): octubre 2026, 1,66 %', () => {
		const r = s.parsearResolucionAnses(fixture('anses-res-284-2026.htm'));
		assert.strictEqual(r.mes, '2026-10');
		assert.strictEqual(r.movilidadPct, 1.66);
		assert.strictEqual(r.haberMinimo, 435748.51);
		assert.strictEqual(r.haberMaximo, 2932174.85);
		assert.strictEqual(r.pbu, 199335.05);
	});

	it('Res. 317/2025: octubre 2025', () => {
		const r = s.parsearResolucionAnses(fixture('anses-res-317-2025.htm'));
		assert.strictEqual(r.norma, 'Resolución 317/2025');
		assert.strictEqual(r.mes, '2025-10');
		assert.strictEqual(r.movilidadPct, 1.88);
		assert.strictEqual(r.haberMinimo, 326298.38);
		assert.strictEqual(r.baseImponibleMaxima, 3571608.54);
	});

	it('Res. 62/2024: abril 2024 sin % de movilidad (se deriva después)', () => {
		const r = s.parsearResolucionAnses(fixture('anses-res-62-2024.htm'));
		assert.strictEqual(r.mes, '2024-04');
		assert.strictEqual(r.movilidadPct, null);
		assert.strictEqual(r.haberMinimo, 171283.31);
		assert.strictEqual(r.pbu, 78354.3);
		assert.deepStrictEqual(r.errores, []);
	});

	it('Res. 186/2024 trae solo el incremento DNU 274/24 de junio (8,83 %), no el 41,48 % de la ley 27.609', () => {
		const r = s.parsearResolucionAnses(fixture('anses-res-186-2024.htm'));
		assert.strictEqual(r.mes, '2024-06');
		assert.strictEqual(r.movilidadPct, 8.83);
		assert.strictEqual(r.haberMinimo, null);
	});

	it('Res. 188/2024: el "mayo" errado del art. 2 no cambia el mes (junio)', () => {
		const r = s.parsearResolucionAnses(fixture('anses-res-188-2024.htm'));
		assert.strictEqual(r.mes, '2024-06');
		assert.strictEqual(r.haberMinimo, 206931.1);
		assert.strictEqual(r.haberMaximo, 1392450.38);
		assert.strictEqual(r.pbu, 94661.54);
	});
});

describe('datosPrevisionales - parseo de decretos de bono', () => {
	it('Dec. 1108/2026: bono de $70.000 en octubre 2026', () => {
		const r = s.parsearDecretoBono(fixture('bono-dec-1108-2026.htm'));
		assert.strictEqual(r.norma, 'Decreto 1108/2026');
		assert.strictEqual(r.tipo, 'bono extraordinario previsional');
		// sin importes en el art. 3: el umbral es el haber mínimo del mes (hasta: null)
		assert.deepStrictEqual(r.pagos, [{ mes: '2026-10', monto: 70000, escalones: [{ hasta: null, monto: 70000 }] }]);
		assert.strictEqual(r.escalonado, false);
		assert.strictEqual(r.previsional, true);
	});

	it('Dec. 532/2022: refuerzo escalonado de $7.000 en sep, oct y nov 2022', () => {
		const r = s.parsearDecretoBono(fixture('bono-dec-532-2022.htm'));
		assert.strictEqual(r.tipo, 'refuerzo de ingreso previsional');
		assert.deepStrictEqual(r.pagos.map((p) => p.mes), ['2022-09', '2022-10', '2022-11']);
		assert.ok(r.pagos.every((p) => p.monto === 7000));
		assert.strictEqual(r.escalonado, true);
		assert.deepStrictEqual(r.pagos[0].escalones, [{ hasta: 43352.59, monto: 7000 }, { hasta: 86705.18, monto: 4000 }]);
	});

	it('Dec. 788/2022: meses que cruzan el año (dic 2022, ene y feb 2023)', () => {
		const r = s.parsearDecretoBono(fixture('bono-dec-788-2022.htm'));
		assert.deepStrictEqual(r.pagos.map(({ mes, monto }) => ({ mes, monto })), [{ mes: '2022-12', monto: 10000 }, { mes: '2023-01', monto: 10000 }, { mes: '2023-02', monto: 10000 }]);
		assert.deepStrictEqual(r.pagos[2].escalones, [{ hasta: 50124.26, monto: 10000 }, { hasta: 100248.52, monto: 7000 }]);
	});

	it('Dec. 282/2023: montos distintos "respectivamente" por mes', () => {
		const r = s.parsearDecretoBono(fixture('bono-dec-282-2023.htm'));
		assert.deepStrictEqual(r.pagos.map(({ mes, monto }) => ({ mes, monto })), [{ mes: '2023-06', monto: 15000 }, { mes: '2023-07', monto: 17000 }, { mes: '2023-08', monto: 20000 }]);
		assert.strictEqual(r.escalonado, true);
		// cada mes con su bloque "correspondiente al mes de …"
		assert.deepStrictEqual(r.pagos.map((p) => p.escalones[0]), [{ hasta: 70938.24, monto: 15000 }, { hasta: 70938.24, monto: 17000 }, { hasta: 70938.24, monto: 20000 }]);
		assert.ok(r.pagos.every((p) => p.escalones[1].hasta === 141876.48));
	});

	it('Dec. 309/2020: "por única vez" en abril (el art. 1 sigue con la AUH, que cita marzo)', () => {
		const r = s.parsearDecretoBono(fixture('bono-dec-309-2020.htm'));
		assert.deepStrictEqual(r.pagos, [{ mes: '2020-04', monto: 3000, escalones: [{ hasta: null, monto: 3000 }] }]);
		assert.strictEqual(r.previsional, true);
	});

	it('Dec. 594/2019: subsidio de la AUH, no previsional', () => {
		const r = s.parsearDecretoBono(fixture('bono-dec-594-2019.htm'));
		assert.strictEqual(r.previsional, false);
	});

	it('Dec. 215/2022: umbral de 2 haberes mínimos ("de hasta")', () => {
		const r = s.parsearDecretoBono(fixture('bono-dec-215-2022.htm'));
		assert.deepStrictEqual(r.pagos[0].escalones, [{ hasta: 65260.8, monto: 12000 }]);
	});

	it('Dec. 268/2024: cita el mínimo de marzo; la propuesta de abril toma el vigente', () => {
		const r = s.parsearDecretoBono(fixture('bono-dec-268-2024.htm'));
		assert.deepStrictEqual(r.pagos[0].escalones, [{ hasta: 134445.3, monto: 70000 }]);
		const { meses } = s.construirPropuesta({
			resoluciones: [{ id: 1, mes: '2024-04', norma: 'Resolución X/2024', haberMinimo: 171283.31, movilidadPct: 27.4 }],
			bonos: [{ ...r, url: 'u' }], smvm: [], desde: '2024-04', hasta: '2024-04',
			existentes: { '2024-03': { haberMinimoJubilacion: 134445.3 } },
		});
		assert.deepStrictEqual(meses[0].propuesto.bonoEscalones, [{ hasta: null, monto: 70000, norma: 'Decreto 268/2024' }]);
		assert.ok(meses[0].avisos.some((a) => /mes anterior/.test(a)));
	});
});

describe('datosPrevisionales - parseo de resoluciones del SMVM', () => {
	it('Res. 4/2026: ocho tramos de sep 2026 a abr 2027 ("1° de noviembre 2026" sin "de")', () => {
		const r = s.parsearResolucionSmvm(fixture('smvm-res-4-2026.htm'));
		assert.strictEqual(r.norma, 'Resolución 4/2026');
		assert.strictEqual(r.tramos.length, 8);
		assert.deepStrictEqual(r.tramos[0], { mes: '2026-09', monto: 383800 });
		assert.deepStrictEqual(r.tramos[2], { mes: '2026-11', monto: 398800 });
		assert.deepStrictEqual(r.tramos[7], { mes: '2027-04', monto: 437000 });
	});

	it('Res. 13/2024: tramos con centavos', () => {
		const r = s.parsearResolucionSmvm(fixture('smvm-res-13-2024.htm'));
		assert.deepStrictEqual(r.tramos, [
			{ mes: '2024-07', monto: 254231.91 }, { mes: '2024-08', monto: 262432.93 },
			{ mes: '2024-09', monto: 268056.5 }, { mes: '2024-10', monto: 271571.22 },
		]);
	});

	it('smvmVigente repite el último tramo fijado', () => {
		const tramos = [{ mes: '2025-08', monto: 322000 }, { mes: '2025-11', monto: 328400 }];
		assert.strictEqual(s.smvmVigente(tramos, '2025-10').monto, 322000);
		assert.strictEqual(s.smvmVigente(tramos, '2025-11').monto, 328400);
		assert.strictEqual(s.smvmVigente(tramos, '2025-07'), null);
	});
});

describe('datosPrevisionales - listas de InfoLeg', () => {
	it('vínculos del DNU 274/24: ids (con jsessionid en el href), fecha y clasificación', () => {
		const filas = s.parsearListaInfoleg(fixture('lista-vinculos-dnu-274-24.html'));
		const res139 = filas.find((f) => f.id === 426224);
		assert.ok(res139);
		assert.strictEqual(res139.publicacion, '2026-05-29');
		assert.strictEqual(s.clasificarFila(res139), 'anses');
		assert.strictEqual(s.clasificarFila(filas.find((f) => f.id === 403570)), 'bono'); // Dec. 783/2024
		assert.strictEqual(s.clasificarFila(filas.find((f) => f.id === 414513)), null); // asignaciones familiares
		assert.strictEqual(s.clasificarFila(filas.find((f) => f.id === 397818)), 'anses'); // "HABERES - ESTABLECENSE"
	});

	it('búsqueda del Consejo del Salario: fija vs convocatoria', () => {
		const filas = s.parsearListaInfoleg(fixture('lista-busqueda-consejo-smvm.html'));
		assert.strictEqual(s.clasificarFila(filas.find((f) => f.id === 429565)), 'smvm'); // Res. 4/2026
		assert.strictEqual(s.clasificarFila(filas.find((f) => f.id === 402086)), 'smvm'); // Res. 13/2024 "SUMAS - FIJANSE"
		assert.strictEqual(s.clasificarFila(filas.find((f) => f.id === 429020)), null); // convocatoria
	});
});

describe('datosPrevisionales - propuesta y diff', () => {
	const existentes = {
		'2026-05': { haberMinimoJubilacion: 393174.1, topePC: 81780.11, movilidadGeneral: 1.0338 },
	};
	const resoluciones = [{ id: 426224, url: 'u139', ...s.parsearResolucionAnses(fixture('anses-res-139-2026.htm')) }];
	const bonos = [{ id: 1, url: 'ub', norma: 'Decreto 399/2026', tipo: 'bono extraordinario previsional', escalonado: false, pagos: [{ mes: '2026-06', monto: 70000 }] }];
	const smvm = [{ mes: '2026-05', monto: 363000, norma: 'Resolución 9/2025', url: 'us' }, { mes: '2026-06', monto: 367800, norma: 'Resolución 9/2025', url: 'us' }];

	it('arma el mes con las reglas: pensión = jubilación, topePC encadenado, suplemento 82 %', () => {
		const { meses } = s.construirPropuesta({ resoluciones, bonos, smvm, existentes, desde: '2026-06' });
		assert.strictEqual(meses.length, 1);
		const p = meses[0].propuesto;
		assert.strictEqual(p.movilidadGeneral, 1.0258);
		assert.strictEqual(p.haberMinimoPension, p.haberMinimoJubilacion);
		assert.strictEqual(p.haberMaximoPension, 2713948.17);
		assert.strictEqual(p.maximoImponible, 4414652.38);
		assert.strictEqual(p.topePC, 83890.04); // 81.780,11 × 1,0258
		assert.strictEqual(p.bono, 70000);
		assert.strictEqual(p.salarioMVM, 367800);
		assert.strictEqual(p.suplemento82SMVM, 0); // 0,82 × 367.800 < haber mínimo
		assert.strictEqual(p.norma, 'Resolución 139/2026');
		assert.deepStrictEqual(meses[0].avisos, []);
	});

	it('deriva la movilidad cuando la resolución no trae el % (abril 2024)', () => {
		const r62 = { id: 397818, url: 'u62', ...s.parsearResolucionAnses(fixture('anses-res-62-2024.htm')) };
		const { meses } = s.construirPropuesta({ resoluciones: [r62], bonos: [], smvm: [], existentes: { '2024-03': { haberMinimoJubilacion: 134445.3, topePC: 27964.59 } }, desde: '2024-04' });
		assert.strictEqual(meses[0].propuesto.movilidadGeneral, 1.274);
		assert.ok(meses[0].avisos.some((a) => /derivada/.test(a)));
	});

	it('suplemento82SMVM = max(0, 0,82 × SMVM − haber mínimo), como en 2018–2024', () => {
		const { meses } = s.construirPropuesta({
			resoluciones: [{ id: 1, mes: '2024-04', norma: 'R', movilidadPct: 27.4, haberMinimo: 171283.31 }],
			bonos: [], smvm: [{ mes: '2024-04', monto: 221052, norma: 'Resolución 9/2024' }], desde: '2024-04',
		});
		assert.strictEqual(meses[0].propuesto.suplemento82SMVM, 9979.33);
	});

	it('diff: vacío → nuevo, igual → igual, distinto → conflicto; SMVM en 0 cuenta como vacío', () => {
		const cambios = s.diffMes(
			{ pbu: 179859.19, haberMinimoJubilacion: 393174.1, salarioMVM: 0, suplemento82SMVM: 0, norma: '' },
			{ pbu: 179859.2, haberMinimoJubilacion: 393174.1, salarioMVM: 363000, suplemento82SMVM: 0, norma: 'Resolución 110/2026', puam: 314539.28 }
		);
		const estado = Object.fromEntries(cambios.map((c) => [c.campo, c.estado]));
		assert.deepStrictEqual(estado, { pbu: 'conflicto', haberMinimoJubilacion: 'igual', salarioMVM: 'nuevo', suplemento82SMVM: 'igual', norma: 'nuevo', puam: 'nuevo' });
	});

	it('diff: bono 0 sin norma se completa cuando sale el decreto; con norma es un valor', () => {
		const a = s.diffMes({ bono: 0, bonoNorma: '' }, { bono: 70000, bonoNorma: 'Decreto 1108/2026' });
		assert.strictEqual(a.find((c) => c.campo === 'bono').estado, 'nuevo');
		const b = s.diffMes({ bono: 0, bonoNorma: 'x' }, { bono: 70000 });
		assert.strictEqual(b[0].estado, 'conflicto');
	});

	it('parsearMonto entiende los formatos de InfoLeg', () => {
		assert.strictEqual(s.parsearMonto('403.317,99'), 403317.99);
		assert.strictEqual(s.parsearMonto('180.000.-'), 180000);
		assert.strictEqual(s.parsearMonto('1105,26'), 1105.26);
		assert.strictEqual(s.parsearMonto('70.000'), 70000);
	});
});
