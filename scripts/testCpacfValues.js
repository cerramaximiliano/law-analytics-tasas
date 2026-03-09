/**
 * Script de diagnóstico: qué valores devuelve CPACF para cada tipo de tasa.
 *
 * Hace login, selecciona cada tasa del mapa, realiza un cálculo sobre una
 * ventana de 7 días y muestra los campos extraídos por período:
 *   fecha_desde, fecha_hasta, porcentaje_interes_diario,
 *   porcentaje_interes_mensual, porcentaje_interes_anual
 *
 * NO escribe en la base de datos.
 *
 * Uso:
 *   node scripts/testCpacfValues.js
 *   node scripts/testCpacfValues.js --tasa=tasaActivaBNA
 *   node scripts/testCpacfValues.js --dias=14
 */

'use strict';

require('dotenv').config();
const moment = require('moment');

// Importar el scraper sin sus dependencias de base de datos
const { CPACFScraper } = require('../server/services/scrapers/tasas/colegioService');

// Mapa tipoTasa → rateId en CPACF (mismo que en cpacfGapFillerService.js)
const CPACF_TASA_MAP = [
	{ tipoTasa: 'tasaActivaBNA',      rateId: '1'  },
	{ tipoTasa: 'tasaPasivaBNA',      rateId: '2'  },
	{ tipoTasa: 'tasaActivaCNAT2658', rateId: '22' },
	{ tipoTasa: 'tasaActivaCNAT2764', rateId: '23' },
	{ tipoTasa: 'tasaActivaTnaBNA',   rateId: '25' },
];

// Parsear argumentos
const args = process.argv.slice(2);
const tasaArg = args.find(a => a.startsWith('--tasa='));
const diasArg = args.find(a => a.startsWith('--dias='));

const SOLO_TASA = tasaArg ? tasaArg.split('=')[1] : null;
const DIAS = diasArg ? parseInt(diasArg.split('=')[1], 10) : 7;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDDMMYYYY(m) {
	return m.format('DD/MM/YYYY');
}

function presentar(detalles, rateId, tipoTasa) {
	if (!Array.isArray(detalles) || detalles.length === 0) {
		console.log(`  ⚠️  Sin detalles extraídos`);
		return;
	}

	console.log(`  Períodos extraídos: ${detalles.length}`);
	console.log(`  ${'Desde'.padEnd(12)} ${'Hasta'.padEnd(12)} ${'Diario'.padStart(10)} ${'Mensual'.padStart(10)} ${'Anual'.padStart(10)}  Modelo`);
	console.log(`  ${'─'.repeat(70)}`);

	for (const d of detalles) {
		const diario  = d.porcentaje_interes_diario  != null ? d.porcentaje_interes_diario.toFixed(6)  : 'N/A';
		const mensual = d.porcentaje_interes_mensual != null ? d.porcentaje_interes_mensual.toFixed(6) : 'N/A';
		const anual   = d.porcentaje_interes_anual   != null ? d.porcentaje_interes_anual.toFixed(6)   : 'N/A';
		const modelo  = d.modeloTabla != null ? `M${d.modeloTabla}` : '?';

		console.log(`  ${(d.fecha_desde || '?').padEnd(12)} ${(d.fecha_hasta || '?').padEnd(12)} ${diario.padStart(10)} ${mensual.padStart(10)} ${anual.padStart(10)}  ${modelo}`);
	}

	// Resumen de campos disponibles
	const tieneDiario  = detalles.some(d => d.porcentaje_interes_diario  != null);
	const tieneMensual = detalles.some(d => d.porcentaje_interes_mensual != null);
	const tieneAnual   = detalles.some(d => d.porcentaje_interes_anual   != null);

	console.log(`\n  Campos disponibles:`);
	console.log(`    porcentaje_interes_diario:  ${tieneDiario  ? '✅' : '❌'}`);
	console.log(`    porcentaje_interes_mensual: ${tieneMensual ? '✅' : '❌'}`);
	console.log(`    porcentaje_interes_anual:   ${tieneAnual   ? '✅' : '❌'}`);

	if (!tieneDiario) {
		if (tieneMensual) {
			console.log(`\n  ⚠️  ATENCIÓN: no hay tasa diaria. Se puede derivar: mensual / 30.4`);
		} else if (tieneAnual) {
			console.log(`\n  ⚠️  ATENCIÓN: no hay tasa diaria ni mensual. Se puede derivar: anual / 365`);
		} else {
			console.log(`\n  ❌  ERROR: sin ningún valor de tasa disponible`);
		}
	} else {
		console.log(`\n  ✅  Tasa diaria disponible: procesarYGuardarTasas funcionará correctamente`);
	}

	// Verificar que el valor que se guardaría en la BD tiene sentido
	const valorGuardado = detalles[0].porcentaje_interes_diario;
	if (valorGuardado != null) {
		const anualEquivalente = valorGuardado * 365;
		console.log(`\n  Valor que se guardaría en BD (primer período): ${valorGuardado} (≈ ${anualEquivalente.toFixed(2)}% anual)`);
	}
}

// ─── Test por tasa ────────────────────────────────────────────────────────────

async function testearTasa(scraper, tipoTasa, rateId, fechaDesde, fechaHasta) {
	console.log(`\n┌─ [${tipoTasa}] (rateId: ${rateId})`);
	console.log(`│  Rango: ${fechaDesde} → ${fechaHasta}`);

	try {
		// Volver a la página de selección de tasa
		const seleccionada = await scraper.selectRate(rateId);
		if (!seleccionada) {
			console.log(`│  ❌ No se pudo seleccionar la tasa`);
			return;
		}

		const formInfo = scraper.calculatorFormInfo;
		if (formInfo) {
			console.log(`│  Fecha mín CPACF: ${formInfo.minDateFrom || 'N/A'}`);
			console.log(`│  Fecha máx CPACF: ${formInfo.maxDateTo  || 'N/A'}`);
			if (formInfo.capitalizationOptions?.length > 0) {
				console.log(`│  Capitalización:  ${formInfo.capitalizationOptions.map(o => `${o.value}=${o.text}`).join(', ')}`);
			}
		}

		// Construir params de cálculo
		const params = {
			capital: '100000',
			date_from_0: fechaDesde,
			date_to: fechaHasta,
		};

		if (formInfo?.capitalizationOptions?.length > 0) {
			params.capitalization = formInfo.capitalizationOptions[0].value;
		}

		if (formInfo?.requiresFirstCapitalizationDate) {
			// Usar la fecha de inicio como primera capitalización
			params.date_first_capitalization = fechaDesde;
		}

		const resultado = await scraper.calcular(params);

		if (!resultado || (!resultado.detalles && !resultado.error)) {
			console.log(`│  ⚠️  Sin resultado`);
			console.log(`│  Resultado raw: ${JSON.stringify(resultado).slice(0, 200)}`);
			return;
		}

		if (resultado.error) {
			console.log(`│  ❌ Error: ${resultado.error}`);
			return;
		}

		// Agregar el modelo de tabla al detalle si no está
		if (resultado.modeloTabla != null && Array.isArray(resultado.detalles)) {
			resultado.detalles = resultado.detalles.map(d => ({ ...d, modeloTabla: resultado.modeloTabla }));
		}

		console.log(`└─ Resultados:`);
		presentar(resultado.detalles, rateId, tipoTasa);

	} catch (error) {
		console.log(`│  ❌ Error: ${error.message}`);
		if (error.message.includes('500')) {
			console.log(`│  (Error 500 del servidor CPACF — intentá con rango más corto)`);
		}
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
	console.log(`\n${'='.repeat(60)}`);
	console.log('DIAGNÓSTICO: Valores extraídos de CPACF por tipo de tasa');
	console.log(`${'='.repeat(60)}`);

	const hoy     = moment.utc().subtract(1, 'days').startOf('day');
	const inicio  = hoy.clone().subtract(DIAS - 1, 'days');
	const fechaDesde = fmtDDMMYYYY(inicio);
	const fechaHasta = fmtDDMMYYYY(hoy);

	console.log(`Ventana de prueba: ${fechaDesde} → ${fechaHasta} (${DIAS} días)`);
	if (SOLO_TASA) console.log(`Filtro: ${SOLO_TASA}`);
	console.log();

	const tasas = SOLO_TASA
		? CPACF_TASA_MAP.filter(t => t.tipoTasa === SOLO_TASA)
		: CPACF_TASA_MAP;

	if (tasas.length === 0) {
		console.error(`Tasa "${SOLO_TASA}" no encontrada en CPACF_TASA_MAP`);
		process.exit(1);
	}

	// Mostrar tasas disponibles primero con una sesión temporal
	{
		const scraperInfo = new CPACFScraper();
		try {
			console.log('Inicializando scraper para listar tasas...');
			await scraperInfo.initialize();
			await scraperInfo.login();
			const disponibles = await scraperInfo.getAvailableRates();
			console.log(`Tasas disponibles en CPACF (${disponibles.length} total):`);
			disponibles.forEach(t => console.log(`  [${t.id}] ${t.name}`));
		} finally {
			await scraperInfo.close();
		}
	}

	// Probar cada tasa con una sesión independiente para evitar que la navegación
	// post-cálculo rompa la siguiente selección de tasa
	for (const { tipoTasa, rateId } of tasas) {
		const scraper = new CPACFScraper();
		try {
			console.log(`\nIniciando sesión para [${tipoTasa}]...`);
			await scraper.initialize();
			await scraper.login();
			await testearTasa(scraper, tipoTasa, rateId, fechaDesde, fechaHasta);
		} finally {
			await scraper.close();
		}
		// Pausa entre sesiones
		if (tasas.indexOf(tasas.find(t => t.tipoTasa === tipoTasa)) < tasas.length - 1) {
			await new Promise(r => setTimeout(r, 3000));
		}
	}

	console.log(`\n${'='.repeat(60)}`);
	console.log('Diagnóstico completado.');
}

run().catch(err => {
	console.error('Error fatal:', err);
	process.exit(1);
});
