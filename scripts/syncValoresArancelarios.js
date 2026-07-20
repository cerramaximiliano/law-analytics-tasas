/**
 * Sincroniza valores arancelarios (UMA, JUS) contra la base — CLI.
 * La lógica vive en los *SyncService, que son los mismos que usa el cron; este
 * archivo solo agrega la conexión a Mongo y el volcado a consola.
 *
 * Uso:
 *   node scripts/syncValoresArancelarios.js uma            # UMA PJN (CPACF)
 *   node scripts/syncValoresArancelarios.js jus            # JUS PBA (SCBA)
 *   node scripts/syncValoresArancelarios.js uma --simular  # sin escribir
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { sincronizarUma } = require('../server/services/scrapers/umaSyncService');
const { sincronizarJusScba } = require('../server/services/scrapers/jusScbaSyncService');
const { sincronizarJusCordoba } = require('../server/services/scrapers/jusCordobaSyncService');

const FUENTES = {
	uma: (simular) => sincronizarUma({ ambito: 'PJN', simular }),
	'uma-caba': (simular) => sincronizarUma({ ambito: 'CABA', simular }),
	jus: (simular) => sincronizarJusScba({ simular }),
	'jus-cba': (simular) => sincronizarJusCordoba({ simular })
};

const fmt = (n) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2 });

async function run() {
	const args = process.argv.slice(2);
	const cual = args.find((a) => !a.startsWith('--'));
	const simular = args.includes('--simular');
	const fn = FUENTES[cual];

	if (!fn) {
		console.log(`Uso: node scripts/syncValoresArancelarios.js <${Object.keys(FUENTES).join('|')}> [--simular]`);
		return;
	}

	await mongoose.connect(process.env.URLDB);
	try {
		const r = await fn(simular);
		console.log(`\n${r.publicados} valores publicados en la fuente.`);
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
