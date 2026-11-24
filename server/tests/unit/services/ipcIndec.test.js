const assert = require('assert');
const s = require('../../../services/scrapers/tasas/indicesMensualesService');

describe('indicesMensuales - IPC desde la API del INDEC', () => {
	// Filas reales de api.indec.gob.ar/v1/ipc_nacional leídas el 24/11/2026
	const filas = [
		{ periodo: '202610', valor: 12785.9321 },
		{ periodo: '202608', valor: 12276.766 },
		{ periodo: '202609', valor: 12514.1508 },
	];

	it('convierte el período AAAAMM y ordena', () => {
		assert.deepStrictEqual(s.parsearIpcIndec(filas), [
			{ periodo: '2026-08', valor: 12276.766 },
			{ periodo: '2026-09', valor: 12514.1508 },
			{ periodo: '2026-10', valor: 12785.9321 },
		]);
	});

	it('descarta filas sin valor o con período inválido; una respuesta de error devuelve vacío', () => {
		assert.deepStrictEqual(s.parsearIpcIndec([{ periodo: '202611', valor: null }, { periodo: '2026', valor: 1 }, { periodo: '202610', valor: 12785.9321 }]), [{ periodo: '2026-10', valor: 12785.9321 }]);
		assert.deepStrictEqual(s.parsearIpcIndec({ code: '42501', message: 'permission denied for schema api' }), []);
	});

	it('el INDEC manda sobre datos.gob.ar: agrega el mes que la republicación todavía no tiene', () => {
		const republicada = [{ periodo: '2026-08', valor: 12276.766 }, { periodo: '2026-09', valor: 12514.1508 }];
		const { datos, diferencias } = s.superponerOficial(republicada, s.parsearIpcIndec(filas), 'INDEC');
		assert.strictEqual(datos.length, 3);
		assert.deepStrictEqual(diferencias, [{ periodo: '2026-10', republicada: null, oficial: 12785.9321 }]);
	});

	it('sin token no consulta y avisa (el servicio sigue con datos.gob.ar)', async () => {
		const previo = process.env.INDEC_API_KEY;
		delete process.env.INDEC_API_KEY;
		await assert.rejects(() => s.leerIpcIndec('2026-01-01'), /INDEC_API_KEY/);
		if (previo !== undefined) process.env.INDEC_API_KEY = previo;
	});

	it('la serie ipc declara al INDEC como fuente oficial', () => {
		assert.strictEqual(s.SERIES_MENSUALES.ipc.oficial, 'ipcIndec');
	});
});
