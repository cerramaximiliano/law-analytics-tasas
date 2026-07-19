/**
 * Sincroniza los valores UMA publicados por el CPACF contra la base.
 *
 * Es idempotente: cada valor se identifica por (unidad, ámbito, vigenciaDesde),
 * así que correrlo dos veces no duplica nada y correrlo cada mes solo agrega el
 * escalón nuevo. Está pensado para colgarlo de un cron, pero se puede correr a
 * mano cuando sale una resolución.
 *
 * Uso:
 *   node scripts/syncUmaCpacf.js              # sincroniza
 *   node scripts/syncUmaCpacf.js --simular    # muestra qué haría, sin escribir
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const ValorArancelario = require('../server/models/valoresArancelarios');
const { obtenerValores } = require('../server/services/scrapers/umaCpacfService');

const fmt = (n) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2 });
const dia = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

async function run() {
	const simular = process.argv.includes('--simular');
	const filas = await obtenerValores('PJN');
	console.log(`CPACF: ${filas.length} valores publicados.`);

	await mongoose.connect(process.env.URLDB);
	try {
		let nuevos = 0;
		let corregidos = 0;
		let sinCambios = 0;

		for (const f of filas) {
			const clave = { unidad: f.unidad, ambito: f.ambito, vigenciaDesde: f.vigenciaDesde };
			const previo = await ValorArancelario.findOne(clave);

			if (previo && previo.valor === f.valor) {
				sinCambios++;
				continue;
			}

			// Un valor que cambia para un período ya cargado no es rutina: o lo
			// cargamos mal, o el CPACF publicó una corrección. Se avisa siempre.
			if (previo) {
				corregidos++;
				console.log(`  CAMBIO ${f.periodo}: ${fmt(previo.valor)} → ${fmt(f.valor)} (${f.norma})`);
			} else {
				nuevos++;
				console.log(`  nuevo  ${f.periodo}: ${fmt(f.valor)} (${f.norma}, publicada ${dia(f.fechaPublicacion)})`);
			}

			if (!simular) {
				await ValorArancelario.findOneAndUpdate(
					clave,
					{ $set: { ...f, estado: true } },
					{ upsert: true, setDefaultsOnInsert: true }
				);
			}
		}

		console.log(`\n${nuevos} nuevo(s), ${corregidos} corregido(s), ${sinCambios} sin cambios.`);
		if (simular) console.log('(--simular: no se escribió nada.)');

		const vigente = await ValorArancelario.vigente('UMA', 'PJN');
		if (vigente) {
			console.log(`\nVigente hoy: ${fmt(vigente.valor)} — ${vigente.periodo} (${vigente.norma})`);
		}
	} finally {
		await mongoose.connection.close();
	}
}

run().catch((err) => {
	console.error(err.message);
	process.exitCode = 1;
});
