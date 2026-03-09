/**
 * Script de corrección: limpia fechasFaltantes en TasasConfig para fechas
 * que ya tienen un valor guardado en la colección Tasas.
 *
 * Útil para corregir el estado tras haber guardado valores manualmente
 * antes del fix que agrega la llamada a actualizarConfigTasa.
 *
 * Uso:
 *   node scripts/fixFechasFaltantes.js
 *   node scripts/fixFechasFaltantes.js --dry-run   (solo muestra, no modifica)
 *   node scripts/fixFechasFaltantes.js --tasa=tasaActivaBNA
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const moment = require('moment');
const TasasConfig = require('../server/models/tasasConfig');
const Tasas = require('../server/models/tasas');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const tasaArg = args.find(a => a.startsWith('--tasa='));
const SOLO_TASA = tasaArg ? tasaArg.split('=')[1] : null;

async function recalcularFechaUltimaCompleta(config) {
	if (!config.fechasFaltantes || config.fechasFaltantes.length === 0) {
		// Sin faltantes: fechaUltimaCompleta = fechaUltima
		return config.fechaUltima;
	}
	const ordenadas = [...config.fechasFaltantes].sort((a, b) => a - b);
	const primerFaltante = moment.utc(ordenadas[0]).startOf('day');
	const nueva = primerFaltante.clone().subtract(1, 'days');
	// No puede ser anterior a fechaInicio
	if (config.fechaInicio && nueva.isBefore(moment.utc(config.fechaInicio).startOf('day'))) {
		return config.fechaInicio;
	}
	return nueva.toDate();
}

async function procesarTasa(config) {
	const { tipoTasa, fechasFaltantes } = config;

	if (!fechasFaltantes || fechasFaltantes.length === 0) {
		console.log(`  [${tipoTasa}] Sin fechas faltantes — omitido`);
		return { tipoTasa, limpiadas: 0, restantes: 0 };
	}

	console.log(`\n  [${tipoTasa}] ${fechasFaltantes.length} fecha(s) faltante(s):`);

	const fechasAEliminar = [];

	for (const fecha of fechasFaltantes) {
		const inicio = moment.utc(fecha).startOf('day').toDate();
		const fin = moment.utc(fecha).endOf('day').toDate();

		const doc = await Tasas.findOne(
			{ fecha: { $gte: inicio, $lte: fin }, [tipoTasa]: { $exists: true, $ne: null } },
			{ fecha: 1, [tipoTasa]: 1, [`fuentes.${tipoTasa}`]: 1 }
		);

		const fechaStr = moment.utc(fecha).format('YYYY-MM-DD');
		if (doc) {
			const fuente = doc.fuentes?.[tipoTasa] || 'desconocida';
			console.log(`    ✅ ${fechaStr} → tiene valor ${doc[tipoTasa]} (fuente: ${fuente}) — se eliminará de faltantes`);
			fechasAEliminar.push(fechaStr);
		} else {
			console.log(`    ❌ ${fechaStr} → sin valor en Tasas — se mantiene como faltante`);
		}
	}

	if (fechasAEliminar.length === 0) {
		console.log(`  → No hay fechas para limpiar`);
		return { tipoTasa, limpiadas: 0, restantes: fechasFaltantes.length };
	}

	if (DRY_RUN) {
		console.log(`  → [DRY-RUN] Se limpiarían ${fechasAEliminar.length} fecha(s)`);
		return { tipoTasa, limpiadas: fechasAEliminar.length, restantes: fechasFaltantes.length - fechasAEliminar.length };
	}

	// Filtrar el array
	config.fechasFaltantes = config.fechasFaltantes.filter(f => {
		return !fechasAEliminar.includes(moment.utc(f).format('YYYY-MM-DD'));
	});
	config.markModified('fechasFaltantes');

	// Recalcular fechaUltimaCompleta
	const nuevaFechaUltimaCompleta = await recalcularFechaUltimaCompleta(config);
	config.fechaUltimaCompleta = nuevaFechaUltimaCompleta;
	config.ultimaVerificacion = new Date();

	await config.save();

	const restantes = config.fechasFaltantes.length;
	console.log(`  → Limpiadas: ${fechasAEliminar.length} | Restantes: ${restantes} | fechaUltimaCompleta: ${moment.utc(nuevaFechaUltimaCompleta).format('YYYY-MM-DD')}`);

	return { tipoTasa, limpiadas: fechasAEliminar.length, restantes };
}

async function run() {
	await mongoose.connect(process.env.URLDB);
	console.log('Conectado a MongoDB');

	if (DRY_RUN) console.log('\n⚠️  Modo DRY-RUN: no se realizarán cambios\n');

	const query = SOLO_TASA ? { tipoTasa: SOLO_TASA } : {};
	const configs = await TasasConfig.find(query);

	if (configs.length === 0) {
		console.log('No se encontraron documentos TasasConfig');
		await mongoose.disconnect();
		return;
	}

	console.log(`\nProcesando ${configs.length} tasa(s)...`);

	const resumen = [];
	for (const config of configs) {
		const resultado = await procesarTasa(config);
		resumen.push(resultado);
	}

	console.log('\n' + '='.repeat(50));
	console.log('Resumen:');
	for (const r of resumen) {
		console.log(`  ${r.tipoTasa}: limpiadas=${r.limpiadas}, restantes=${r.restantes}`);
	}
	const totalLimpiadas = resumen.reduce((s, r) => s + r.limpiadas, 0);
	console.log(`\nTotal limpiadas: ${totalLimpiadas}`);

	await mongoose.disconnect();
}

run().catch(err => {
	console.error('Error fatal:', err);
	process.exit(1);
});
