'use strict';
/**
 * Concilia series diarias contra las calculadoras del CPACF (lógica en
 * server/services/scrapers/tasas/conciliacionCPACFService.js). Modo prueba por defecto.
 *
 * Uso:
 *   node scripts/conciliarTasasCPACF.js --tasa=tasaActivaCNAT2658[,otra]          (prueba)
 *   node scripts/conciliarTasasCPACF.js --tasa=tasaActivaCNAT2658 --desde=2024-01-01 --apply
 *   node scripts/conciliarTasasCPACF.js --revertir=<corrida>
 */

require('dotenv').config();
const fs = require('fs');
const database = require('../server/utils/database');
const { conciliarSerie, revertir } = require('../server/services/scrapers/tasas/conciliacionCPACFService');

const args = process.argv.slice(2);
const arg = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];

(async () => {
	await database.connect();
	if (arg('revertir')) {
		await revertir(arg('revertir'));
	} else {
		for (const tipoTasa of (arg('tasa') || '').split(',').filter(Boolean)) {
			const r = await conciliarSerie({ tipoTasa, desde: arg('desde'), hasta: arg('hasta'), aplicar: args.includes('--apply'), ventana: Number(arg('ventana')) || 60, verbose: true });
			const archivo = `./server/files/conciliacion-${tipoTasa}-${r.corrida}.json`;
			fs.writeFileSync(archivo, JSON.stringify(r.diferencias, null, 1));
			console.log(`Detalle completo: ${archivo}`);
		}
	}
	await database.disconnect();
})().catch((e) => {
	console.error('Error fatal:', e.message);
	process.exit(1);
});
