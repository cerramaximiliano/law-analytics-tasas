/**
 * Sincroniza valores arancelarios (UMA, JUS) contra la base — CLI.
 * La lógica vive en los *SyncService, que son los mismos que usa el cron; este
 * archivo solo agrega la conexión a Mongo y el volcado a consola. El mapa de
 * fuentes es el registry compartido (fuentesArancelarias.js).
 *
 * Uso:
 *   node scripts/syncValoresArancelarios.js uma-pjn        # UMA PJN (CPACF)
 *   node scripts/syncValoresArancelarios.js jus-pba        # JUS PBA (SCBA)
 *   node scripts/syncValoresArancelarios.js uma --simular  # alias de uma-pjn, sin escribir
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { FUENTES_ARANCELARIAS } = require('../server/services/scrapers/fuentesArancelarias');

// Aliases históricos del CLI, previos a las claves canónicas del config.
const ALIASES = { uma: 'uma-pjn' };

const fmt = (n) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2 });

async function run() {
	const args = process.argv.slice(2);
	const cual = args.find((a) => !a.startsWith('--'));
	const simular = args.includes('--simular');
	const clave = ALIASES[cual] || cual;
	const fuente = FUENTES_ARANCELARIAS[clave];

	if (!fuente) {
		console.log(`Uso: node scripts/syncValoresArancelarios.js <${Object.keys(FUENTES_ARANCELARIAS).join('|')}> [--simular]`);
		return;
	}

	await mongoose.connect(process.env.URLDB);
	try {
		const r = await fuente.ejecutar(simular);
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
