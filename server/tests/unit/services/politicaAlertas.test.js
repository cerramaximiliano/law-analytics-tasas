const assert = require('assert');
const { firmaProblema, erroresRelevantes, decidirEnvio } = require('../../../utils/politicaAlertas');

const t = (...tipos) => tipos.map((tipoTasa) => ({ tipoTasa }));

describe('politicaAlertas', () => {
	it('la firma no depende del orden y es vacía sin tasas atrasadas', () => {
		assert.strictEqual(firmaProblema(t('tasaPasivaBP', 'tasaActivaBP')), firmaProblema(t('tasaActivaBP', 'tasaPasivaBP')));
		assert.strictEqual(firmaProblema([]), '');
	});

	it('un error de scraping de una tasa al día no se informa', () => {
		// 24/11/2026: timeout del BCRA en TAMAR y TM20 con todas las tasas al día
		assert.deepStrictEqual(erroresRelevantes(t('tasaTAMAR', 'tasaTM20'), []), []);
		assert.deepStrictEqual(erroresRelevantes(t('tasaTAMAR', 'tasaTM20'), t('tasaTM20')), t('tasaTM20'));
	});

	it('avisa cuando el problema aparece y no lo repite', () => {
		const firma = firmaProblema(t('a', 'b'));
		assert.strictEqual(decidirEnvio({ firma, firmaPrevia: null }), 'alerta');
		assert.strictEqual(decidirEnvio({ firma, firmaPrevia: '' }), 'alerta');
		assert.strictEqual(decidirEnvio({ firma, firmaPrevia: firma }), null);
	});

	it('avisa cuando el problema cambia', () => {
		assert.strictEqual(decidirEnvio({ firma: 'a', firmaPrevia: 'a,b' }), 'alerta');
		assert.strictEqual(decidirEnvio({ firma: 'a,b,c', firmaPrevia: 'a,b' }), 'alerta');
	});

	it('avisa una vez cuando se resuelve', () => {
		assert.strictEqual(decidirEnvio({ firma: '', firmaPrevia: 'a,b' }), 'resuelto');
		assert.strictEqual(decidirEnvio({ firma: '', firmaPrevia: '' }), null);
		assert.strictEqual(decidirEnvio({ firma: '', firmaPrevia: null }), null);
	});

	it('el reporte diario sale siempre', () => {
		assert.strictEqual(decidirEnvio({ firma: '', firmaPrevia: '', notificarExito: true }), 'exito');
		assert.strictEqual(decidirEnvio({ firma: '', firmaPrevia: 'a', notificarExito: true }), 'exito');
		assert.strictEqual(decidirEnvio({ firma: 'a', firmaPrevia: 'a', notificarExito: true }), 'alerta');
	});

	it('un incidente de un día entero manda dos correos de las corridas cíclicas (aparece y se resuelve)', () => {
		let previa = '';
		let enviados = 0;
		for (const firma of ['a,b,c', 'a,b,c', 'a,b,c', 'a,b,c', '', '']) {
			if (decidirEnvio({ firma, firmaPrevia: previa })) {
				enviados++;
				previa = firma;
			}
		}
		assert.strictEqual(enviados, 2);
	});
});
