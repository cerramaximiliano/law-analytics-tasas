/**
 * Sincroniza los valores UMA del CPACF contra la base — versión de línea de
 * comandos. La lógica vive en server/services/scrapers/umaSyncService.js, que
 * es el mismo que usa el cron; este archivo solo agrega la conexión a Mongo y
 * el volcado a consola.
 *
 * Uso:
 *   node scripts/syncUmaCpacf.js              # sincroniza
 *   node scripts/syncUmaCpacf.js --simular    # muestra qué haría, sin escribir
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { sincronizarUma } = require('../server/services/scrapers/umaSyncService');

const fmt = (n) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2 });

async function run() {
	const simular = process.argv.includes('--simular');

	await mongoose.connect(process.env.URLDB);
	try {
		const r = await sincronizarUma({ ambito: 'PJN', simular });
		console.log(`\nCPACF: ${r.publicados} valores publicados.`);
		console.log(`${r.nuevos} nuevo(s), ${r.corregidos} corregido(s), ${r.sinCambios} sin cambios.`);
		if (simular) console.log('(--simular: no se escribió nada.)');
		if (r.vigente) console.log(`\nVigente hoy: ${fmt(r.vigente.valor)} — ${r.vigente.periodo} (${r.vigente.norma})`);
	} finally {
		await mongoose.connection.close();
	}
}

run().catch((err) => {
	console.error(err.message);
	process.exitCode = 1;
});
