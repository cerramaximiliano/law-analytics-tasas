/**
 * Script de descubrimiento: lista todas las tasas disponibles en CPACF con sus IDs.
 * No escribe en la base de datos.
 *
 * Uso:
 *   node scripts/listCpacfRates.js
 */

'use strict';

require('dotenv').config();
const { CPACFScraper } = require('../server/services/scrapers/tasas/colegioService');

async function run() {
	console.log('\n' + '='.repeat(60));
	console.log('CPACF — Tasas disponibles');
	console.log('='.repeat(60) + '\n');

	const scraper = new CPACFScraper();
	try {
		await scraper.initialize();
		await scraper.login();
		const rates = await scraper.getAvailableRates();

		console.log(`Total: ${rates.length} tasas\n`);
		console.log(`${'ID'.padEnd(6)} Nombre`);
		console.log('─'.repeat(60));
		for (const r of rates) {
			console.log(`${String(r.id).padEnd(6)} ${r.name}`);
		}
	} finally {
		await scraper.close();
	}

	console.log('\n' + '='.repeat(60));
}

run().catch(err => {
	console.error('Error fatal:', err.message);
	process.exit(1);
});
