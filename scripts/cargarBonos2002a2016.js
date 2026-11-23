'use strict';
/**
 * Alcance de los bonos previsionales en `datosprevisionales`:
 *
 *  1. Carga los siete pagos únicos de 2004 a 2016 (Dec. 1670/04, 2300/08, 1879/09, 1856/10, 253/15, 591/16 y
 *     1252/16), que no estaban: el sincronizador arranca en 11/2019. Cada uno con su alcance, norma y URL de InfoLeg.
 *  2. Completa `alcance`, `base`, `universo`, `excluye` y `url` en los escalones de los decretos ya cargados
 *     (12/2019 en adelante), SIN cambiar `hasta`, `monto` ni `norma`.
 *  3. Anota la norma modificatoria de 4/2024 (Dec. 282/2024, que sustituyó el umbral del Dec. 268/2024).
 *
 * Los importes y alcances están en server/services/scrapers/previsional/bonosAlcance.js, con la cita de cada artículo.
 * No toca el suplemento por movilidad de 9/2004 (Dec. 1199/04, ya cargado en `movilidadDiferencial`) ni el piso de
 * cobro de 8/2002 a 6/2003 (Dec. 1275/02, ya cargado en `haberMinimoCobro`): esos los lee el motor del hub.
 *
 * Uso (no depende del logger ni del .env de este repo: alcanza con URLDB en el entorno):
 *   node scripts/cargarBonos2002a2016.js                 # en seco
 *   node scripts/cargarBonos2002a2016.js --apply
 *   node scripts/cargarBonos2002a2016.js --revertir       # en seco: qué desharía
 *   node scripts/cargarBonos2002a2016.js --revertir --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { PAGOS_UNICOS, planMes, planRevertir } = require('../server/services/scrapers/previsional/bonosAlcance');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REVERTIR = args.includes('--revertir');
const per = (d) => d.fecha.toISOString().slice(0, 7);
const esc = (l) => (l || []).map((e) => `${e.hasta === null || e.hasta === undefined ? (e.alcance === 'todos' ? 'máx' : 'mín') : e.hasta}→${e.monto}${e.alcance ? ` [${e.alcance}${e.base ? `, ${e.base}` : ''}${e.universo ? `, ${e.universo}` : ''}${e.excluye ? ', excl.' : ''}${e.normaModificatoria ? `, mod. ${e.normaModificatoria}` : ''}]` : ''}`).join(' · ');

(async () => {
	if (!process.env.URLDB) throw new Error('falta URLDB en el entorno');
	const conn = await mongoose.createConnection(process.env.URLDB, { serverSelectionTimeoutMS: 15000 }).asPromise();
	const col = conn.db.collection('datosprevisionales');
	const docs = await col.find({ estado: { $ne: false } }, { projection: { fecha: 1, bono: 1, bonoNorma: 1, bonoEscalones: 1, 'fuentes.bono': 1, haberMinimoJubilacion: 1, haberMaximoJubilacion: 1 } }).sort({ fecha: 1 }).toArray();
	const porMes = new Map(docs.map((d) => [per(d), d]));
	const meses = [...new Set([...porMes.keys(), ...PAGOS_UNICOS.map((p) => p.mes)])].sort();
	console.log(`datosprevisionales: ${docs.length} meses (${meses[0]} a ${meses[meses.length - 1]}) · ${REVERTIR ? 'REVERTIR' : 'CARGAR'} · ${APPLY ? 'ESCRIBE' : 'EN SECO'}\n`);

	const ops = [];
	const problemas = [];
	for (const mes of meses) {
		const doc = porMes.get(mes) || null;
		if (REVERTIR) {
			const r = planRevertir(mes, doc);
			if (!r) continue;
			console.log(`  ${mes}  ${r.unset ? 'quita el bono cargado' : 'quita las anotaciones de alcance'}  (${doc.bonoNorma || ''})`);
			ops.push({ updateOne: { filter: { _id: doc._id }, update: r.unset ? { $unset: r.unset } : { $set: r.set } } });
			continue;
		}
		const p = planMes(mes, doc);
		if (!p) continue;
		if (p.problema) { problemas.push(`${mes}: ${p.problema}`); console.log(`  ${mes}  PROBLEMA: ${p.problema}`); continue; }
		if (p.tipo === 'pago_unico') {
			console.log(`  ${mes}  NUEVO  ${p.set.bonoNorma}  bono ${p.set.bono}  (mínimo ${doc.haberMinimoJubilacion}, máximo ${doc.haberMaximoJubilacion})`);
			console.log(`           ${esc(p.set.bonoEscalones)}`);
			console.log(`           ${p.set['fuentes.bono'][0]}`);
		} else {
			console.log(`  ${mes}  alcance  ${doc.bonoNorma || ''}`);
			console.log(`           ${esc(p.antes.bonoEscalones)}  ⇒  ${esc(p.set.bonoEscalones)}`);
			if (p.set.bonoNorma) console.log(`           bonoNorma ⇒ ${p.set.bonoNorma}`);
		}
		ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: p.set } } });
	}
	const nuevos = ops.length;
	console.log(`\n${nuevos} documentos a modificar${problemas.length ? ` · ${problemas.length} con problemas (no se tocan)` : ''}.`);
	if (!APPLY) { console.log(`EN SECO: no se escribió nada. Repetir con ${REVERTIR ? '--revertir ' : ''}--apply.`); await conn.close(); return; }
	if (ops.length) { const r = await col.bulkWrite(ops, { ordered: true }); console.log(`escrito: ${r.modifiedCount} de ${ops.length}. Para deshacer: --revertir --apply`); }
	await conn.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
