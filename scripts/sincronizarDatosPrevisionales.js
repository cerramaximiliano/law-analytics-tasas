'use strict';
/**
 * Sincroniza `datosprevisionales` desde InfoLeg (lógica en
 * server/services/scrapers/previsional/datosPrevisionalesService.js). Modo prueba por defecto:
 * muestra el diff campo a campo sin escribir.
 *
 * Uso:
 *   node scripts/sincronizarDatosPrevisionales.js --desde=2024-04                 (prueba)
 *   node scripts/sincronizarDatosPrevisionales.js --desde=2024-04 --hasta=2026-10 --apply
 *   node scripts/sincronizarDatosPrevisionales.js --desde=2024-04 --apply --forzar   (pisa conflictos)
 *   node scripts/sincronizarDatosPrevisionales.js --revertir=<corrida>
 *
 * Con --apply escribe meses nuevos y campos vacíos; los valores ya cargados y distintos
 * (conflictos) solo se pisan con --forzar. Cada cambio queda en `datosprevisionales-sincronizaciones`.
 * Opciones: --solo-cambios (oculta los meses sin diferencias), --json (guarda el detalle en server/files).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const database = require('../server/utils/database');
const svc = require('../server/services/scrapers/previsional/datosPrevisionalesService');

const args = process.argv.slice(2);
const arg = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const flag = (k) => args.includes(`--${k}`);

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? v.toLocaleString('es-AR', { maximumFractionDigits: 4 }) : Array.isArray(v) || typeof v === 'object' ? JSON.stringify(v) : String(v));

(async () => {
	await database.connect();
	if (arg('revertir')) {
		const n = await svc.revertir(arg('revertir'));
		console.log(`Revertidos ${n} cambios de la corrida ${arg('revertir')}`);
		await database.disconnect();
		return;
	}

	// Sin --desde, el servicio arranca 3 meses atrás o en el mes siguiente al último cargado
	const desde = arg('desde');
	const hasta = arg('hasta');
	const aplicar = flag('apply');
	const forzar = flag('forzar');
	console.log(`\n=== datosprevisionales desde ${desde || '(automático)'}${hasta ? ` hasta ${hasta}` : ''} · ${aplicar ? (forzar ? 'APLICAR + FORZAR' : 'APLICAR (solo completar)') : 'PRUEBA (no escribe)'}\n`);
	console.log('Descargando normas de InfoLeg…');
	const r = await svc.sincronizarDatosPrevisionales({ desde, hasta, aplicar, forzar, verbose: true });
	const { normas } = r;

	for (const m of r.meses) {
		const distintos = m.cambios.filter((c) => c.estado !== 'igual');
		if (flag('solo-cambios') && !distintos.length && !m.avisos.length) continue;
		console.log(`\n${m.mes}${m.docNuevo ? '  [MES NUEVO]' : ''}`);
		for (const c of m.cambios) {
			if (c.estado === 'igual' && flag('solo-cambios')) continue;
			if (c.campo === 'fuentes' || c.campo === 'links') continue;
			const marca = { nuevo: '+', conflicto: '≠', igual: '=' }[c.estado];
			console.log(`  ${marca} ${c.campo.padEnd(22)} ${fmt(c.actual).padStart(16)} → ${fmt(c.propuesto)}${c.estado === 'conflicto' ? '   (CONFLICTO: no se pisa sin --forzar)' : ''}`);
		}
		for (const a of m.avisos) console.log(`  ! ${a}`);
	}

	console.log(`\n--- Bonos por mes de pago (desde ${r.desde})`);
	for (const b of normas.bonos) for (const p of b.pagos) if (p.mes >= r.desde) console.log(`  ${p.mes}  $${fmt(p.monto)}  ${b.norma} (${b.tipo}${b.escalonado ? ', escalonado' : ''})`);

	console.log('\n--- SMVM por tramo (incluye meses futuros ya fijados)');
	for (const t of [...normas.smvm].sort((a, b) => (a.mes < b.mes ? -1 : 1))) console.log(`  ${t.mes}  $${fmt(t.monto)}  ${t.norma}`);

	if (r.errores.length) {
		console.log('\n--- ERRORES DE PARSEO');
		for (const e of r.errores) console.log(`  ${e.norma} ${e.url}: ${e.errores.join('; ')}`);
	}
	console.log(`\nResumen: meses ${r.meses.length} · nuevos ${r.resumen.nuevos} · campos nuevos ${r.resumen.camposNuevos} · conflictos ${r.resumen.conflictos} · escritos ${r.resumen.escritos} · errores ${r.errores.length}`);
	if (aplicar && r.resumen.escritos) console.log(`Para revertir: node scripts/sincronizarDatosPrevisionales.js --revertir=${r.corrida}`);

	if (flag('json')) {
		const dir = path.join(__dirname, '../server/files');
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const archivo = path.join(dir, `datosprevisionales-${r.corrida}.json`);
		fs.writeFileSync(archivo, JSON.stringify(r, null, 1));
		console.log(`Detalle completo: ${archivo}`);
	}
	await database.disconnect();
})().catch((e) => {
	console.error('Error fatal:', e.message);
	process.exit(1);
});
