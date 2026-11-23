const assert = require('assert');
const fs = require('fs');
const path = require('path');
const s = require('../../../services/scrapers/tasas/indicesMensualesService');

describe('indicesMensuales - RIPTE desde la fuente oficial', () => {
	// Página de la Secretaría de Trabajo guardada el 23/11/2026: último mes, septiembre de 2026.
	const html = fs.readFileSync(path.join(__dirname, '../../fixtures/ripte-oficial-2026-11-23.html'), 'utf8');
	const oficial = s.parsearTablaRipte(html);

	it('lee la tabla: 21 meses, de 1/2025 a 9/2026, en orden', () => {
		assert.strictEqual(oficial.length, 21);
		assert.deepStrictEqual(oficial[0], { periodo: '2025-01', valor: 1234658.4 });
		assert.deepStrictEqual(oficial[oficial.length - 1], { periodo: '2026-09', valor: 2022244.09 });
		assert.deepStrictEqual(oficial.map((d) => d.periodo), [...oficial.map((d) => d.periodo)].sort());
	});

	it('"Setiembre" y "Septiembre" son el mismo mes; el monto pierde el signo y los puntos de miles', () => {
		const fila = (mes) => `<table><tbody><tr><td>${mes}/2026</td><td>$ 2.022.244,09</td></tr></tbody></table>`;
		assert.deepStrictEqual(s.parsearTablaRipte(fila('Setiembre')), [{ periodo: '2026-09', valor: 2022244.09 }]);
		assert.deepStrictEqual(s.parsearTablaRipte(fila('Septiembre')), [{ periodo: '2026-09', valor: 2022244.09 }]);
	});

	it('una página sin la tabla devuelve vacío (el servicio sigue con datos.gob.ar)', () => {
		assert.deepStrictEqual(s.parsearTablaRipte('<html><body><p>Sitio en mantenimiento</p></body></html>'), []);
	});

	it('la fuente oficial manda: corrige 8/2026 (datos.gob.ar repetía junio) y agrega 9/2026', () => {
		// Lo que devolvía datos.gob.ar el 23/11/2026
		const republicada = [
			{ periodo: '2026-06', valor: 1915878.76 },
			{ periodo: '2026-07', valor: 1946028.12 },
			{ periodo: '2026-08', valor: 1915878.76 },
		];
		const { datos, diferencias } = s.superponerOficial(republicada, oficial.filter((d) => d.periodo >= '2026-06'), 'oficial');
		assert.deepStrictEqual(datos.map((d) => [d.periodo, d.valor]), [
			['2026-06', 1915878.76], ['2026-07', 1946028.12], ['2026-08', 1982518.19], ['2026-09', 2022244.09],
		]);
		assert.deepStrictEqual(diferencias, [
			{ periodo: '2026-08', republicada: 1915878.76, oficial: 1982518.19 },
			{ periodo: '2026-09', republicada: null, oficial: 2022244.09 },
		]);
		assert.ok(datos.every((d) => d.fuente === 'oficial'));
	});

	it('los meses que la fuente oficial no publica conservan el valor y la fuente de la serie republicada', () => {
		const { datos } = s.superponerOficial([{ periodo: '1994-07', valor: 874.86 }], oficial, 'oficial');
		assert.deepStrictEqual(datos[0], { periodo: '1994-07', valor: 874.86 });
	});
});
