const assert = require('assert');
const { calcularCoeficientes, calibrar } = require('../../../services/scrapers/previsional/movilidadDerivada2024');

describe('coeficientes derivados de 2024 (empalme 70/30 y Aguirre trimestral)', () => {
	// Niveles publicados por el INDEC (IPC, base dic-2016 = 100) y la Secretaría de Trabajo (RIPTE)
	const ipc = { '2023-09': 2304.9242, '2023-12': 3533.1922, '2024-03': 5357.0929, '2024-04': 5830.2271 };
	const ripte = { '2023-12': 484298.4, '2024-04': 819501.72 };

	it('reproduce los coeficientes de BlueCorp', () => {
		const c = calibrar(calcularCoeficientes(ipc, ripte));
		assert.deepStrictEqual(c.map((x) => [x.periodo, x.campo]), [['2024-03', 'movilidadAguirreIpcTrimestral'], ['2024-06', 'movilidadAguirreIpcTrimestral'], ['2024-07', 'movilidadEmpalme27426Dnu']]);
		assert.ok(c.every((x) => x.ok), JSON.stringify(c.map((x) => [x.periodo, x.valor, x.referencia])));
	});

	it('un índice revisado que mueve el coeficiente hace fallar la calibración', () => {
		const c = calibrar(calcularCoeficientes({ ...ipc, '2024-04': 5900 }, ripte));
		assert.strictEqual(c.find((x) => x.periodo === '2024-07').ok, false);
		assert.strictEqual(c.find((x) => x.periodo === '2024-03').ok, true);
	});

	it('sin un mes de la serie no calcula', () => {
		assert.throws(() => calcularCoeficientes({ ...ipc, '2023-09': undefined }, ripte), /falta ipc 2023-09/);
		assert.throws(() => calcularCoeficientes(ipc, {}), /falta ripte/);
	});
});
