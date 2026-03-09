/**
 * Obtiene la fecha mínima disponible en CPACF para las 3 tasas Banco Provincia.
 * No escribe en la base de datos.
 */
'use strict';

require('dotenv').config();
const { CPACFScraper } = require('../server/services/scrapers/tasas/colegioService');

const TASAS = [
	{ tipoTasa: 'tasaPasivaBP',        rateId: '4'  },
	{ tipoTasa: 'tasaActivaBPDolares', rateId: '14' },
	{ tipoTasa: 'tasaPasivaBPDolares', rateId: '15' },
];

async function run() {
	console.log('\n' + '='.repeat(60));
	console.log('Banco Provincia — Fechas mínimas en CPACF');
	console.log('='.repeat(60) + '\n');

	for (const { tipoTasa, rateId } of TASAS) {
		const scraper = new CPACFScraper();
		try {
			await scraper.initialize();
			await scraper.login();
			const ok = await scraper.selectRate(rateId);
			if (!ok) {
				console.log(`[${tipoTasa}] ❌ No se pudo seleccionar rateId=${rateId}`);
				continue;
			}
			const info = scraper.calculatorFormInfo;
			console.log(`[${tipoTasa}] (rateId: ${rateId})`);
			console.log(`  minDateFrom: ${info?.minDateFrom || 'N/A'}`);
			console.log(`  maxDateTo:   ${info?.maxDateTo  || 'N/A'}`);
			if (info?.capitalizationOptions?.length > 0) {
				console.log(`  capitalización: ${info.capitalizationOptions.map(o => `${o.value}=${o.text}`).join(', ')}`);
			}
			console.log();
		} finally {
			await scraper.close();
		}
	}
	console.log('='.repeat(60));
}

run().catch(err => {
	console.error('Error fatal:', err.message);
	process.exit(1);
});
