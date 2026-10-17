const assert = require('assert');
const { armarEstado, htmlEstado, textoEstado } = require('../../../services/audit/estadoDatosPrevisionales');

const doc = (mes, extra = {}) => ({ fecha: new Date(`${mes}-01T00:00:00Z`), movilidadGeneral: 1.02, haberMinimoJubilacion: 400000, norma: `Res. ${mes}`, salarioMVM: 390000, bonoNorma: 'Decreto x', ...extra });
const aviso = (horas, extra = {}) => ({ actualizado: new Date(Date.parse('2026-10-17T15:00:00Z') - horas * 36e5), errores: [], resumen: { conflictos: 0, escritos: 0 }, smvmHasta: '2027-04', ansesHasta: '2026-10', ...extra });
const ahora = new Date('2026-10-17T15:00:00Z'); // 12:00 en Buenos Aires

describe('estadoDatosPrevisionales - reporte diario', () => {
	it('al día: mes en curso con datos, el próximo pendiente de publicación sin alertar', () => {
		const e = armarEstado({ docs: [doc('2026-09'), doc('2026-10')], aviso: aviso(3), ahora });
		assert.strictEqual(e.nivel, 'ok');
		assert.strictEqual(e.ultimo.mes, '2026-10');
		assert.deepStrictEqual(e.pendientes, [{ mes: '2026-11', estado: 'pendiente de publicación' }]);
		assert.strictEqual(e.titular, 'datos previsionales al día hasta 2026-10');
	});

	it('mes en curso sin datos: alerta y lo dice el titular', () => {
		const e = armarEstado({ docs: [doc('2026-09')], aviso: aviso(3), ahora });
		assert.strictEqual(e.nivel, 'alerta');
		assert.strictEqual(e.titular, 'mes en curso 2026-10 sin datos previsionales');
		assert.deepStrictEqual(e.pendientes.map((p) => p.estado), ['mes en curso sin datos', 'pendiente de publicación']);
	});

	it('meses atrasados, cron parado y normas sin leer son alerta; un mes en 0 no cuenta como cargado', () => {
		const e = armarEstado({ docs: [doc('2026-07'), doc('2026-08', { movilidadGeneral: 0 })], aviso: aviso(50, { errores: ['a|b'] }), ahora });
		assert.strictEqual(e.nivel, 'alerta');
		assert.strictEqual(e.ultimo.mes, '2026-07');
		assert.ok(e.problemas.includes('mensuales atrasados: 2026-08, 2026-09'));
		assert.ok(e.problemas.some((p) => p.includes('no corre hace 50 h')));
		assert.ok(e.problemas.some((p) => p.includes('1 normas')));
	});

	it('mes en curso sin salario mínimo ni decreto del bono: aviso', () => {
		const e = armarEstado({ docs: [doc('2026-10', { salarioMVM: 0, bonoNorma: '' })], aviso: aviso(3), ahora });
		assert.strictEqual(e.nivel, 'aviso');
		assert.strictEqual(e.titular, '2026-10 sin salario mínimo ni decreto del bono');
	});

	it('html y texto salen sin romper, también sin estado', () => {
		const e = armarEstado({ docs: [doc('2026-10')], aviso: aviso(3), ahora });
		assert.ok(htmlEstado(e).includes('Último mensual con datos'));
		assert.ok(textoEstado(e).includes('2026-11 (pendiente de publicación)'));
		assert.ok(htmlEstado({ nivel: 'error', mensaje: 'x' }).includes('No se pudo leer'));
		assert.ok(htmlEstado(armarEstado({ docs: [], aviso: null, ahora })).includes('sin registro de corridas'));
	});
});
