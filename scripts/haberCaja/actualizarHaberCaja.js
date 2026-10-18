/**
 * Corre a mano la actualización por fechas clave del haber de caja (server/services/scrapers/previsional/
 * haberCajaActualizacionService.js): rentas de autónomos con la movilidad mensual, tope de la PC, % de PC y PAP, factor
 * del suplemento e índice de la ley 27.260 (trimestral, por RIPTE). La tarea programada la corre después de cada
 * sincronización con InfoLeg (12:20 y 18:20).
 *
 *   node scripts/haberCaja/actualizarHaberCaja.js                       (prueba: no escribe)
 *   node scripts/haberCaja/actualizarHaberCaja.js --apply
 *   node scripts/haberCaja/actualizarHaberCaja.js --revertir=<corrida>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { actualizarHaberCaja, revertir, textoHaberCaja } = require('../../server/services/scrapers/previsional/haberCajaActualizacionService');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;

(async () => {
	await mongoose.connect(process.env.URLDB);
	if (arg('revertir')) {
		console.log(`Revertidos ${await revertir(arg('revertir'))} cambios de ${arg('revertir')}`);
		return mongoose.disconnect();
	}
	const aplicar = process.argv.includes('--apply');
	const r = await actualizarHaberCaja({ aplicar, hasta: arg('hasta') });
	console.log(`=== haber de caja · ${aplicar ? 'APLICAR' : 'PRUEBA'} · ${r.cambios.length} cambios, ${r.conflictos.length} conflictos, ${r.pendientes.length} pendientes`);
	console.log(textoHaberCaja(r) || '(nada que actualizar)');
	if (aplicar && r.escritos) console.log(`Para revertir: node scripts/haberCaja/actualizarHaberCaja.js --revertir=${r.corrida}`);
	await mongoose.disconnect();
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
