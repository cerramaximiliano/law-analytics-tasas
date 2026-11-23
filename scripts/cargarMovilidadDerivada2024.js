'use strict';
/**
 * Carga en `datosprevisionales` los coeficientes derivados de IPC y RIPTE que usa el retroactivo previsional del
 * hub para el empalme de 2024:
 *   - movilidadEmpalme27426Dnu       en 2024-07 (Galletta con empalme 70/30)
 *   - movilidadAguirreIpcTrimestral  en 2024-03 y 2024-06 (Aguirre trimestral)
 * Fórmulas y referencias: server/services/scrapers/previsional/movilidadDerivada2024.js.
 *
 * Antes de escribir se calibra contra los coeficientes que resultan de las liquidaciones de BlueCorp del 23/11/2026:
 * si alguno difiere en más de 0,000001, aborta sin escribir.
 *
 * Uso (no depende del logger ni del .env de este repo: alcanza con URLDB en el entorno):
 *   node scripts/cargarMovilidadDerivada2024.js              # en seco
 *   node scripts/cargarMovilidadDerivada2024.js --apply
 *   node scripts/cargarMovilidadDerivada2024.js --revertir   # quita los dos campos (en seco; con --apply, escribe)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
// El script se puede correr copiado fuera del repo (MODULO=/ruta/al/movilidadDerivada2024.js)
const { calcularCoeficientes, calibrar } = require(process.env.MODULO || path.join(__dirname, '../server/services/scrapers/previsional/movilidadDerivada2024.js'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REVERTIR = args.includes('--revertir');
const CAMPOS = ['movilidadEmpalme27426Dnu', 'movilidadAguirreIpcTrimestral'];
const sig = (p) => { const [a, m] = p.split('-').map(Number); return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`; };
const rango = (p) => ({ $gte: new Date(`${p}-01T00:00:00.000Z`), $lt: new Date(`${sig(p)}-01T00:00:00.000Z`) });

(async () => {
	if (!process.env.URLDB) throw new Error('falta URLDB en el entorno');
	const conn = await mongoose.createConnection(process.env.URLDB, { serverSelectionTimeoutMS: 15000 }).asPromise();
	const db = conn.db;
	const dp = db.collection('datosprevisionales');

	if (REVERTIR) {
		const q = { $or: CAMPOS.map((c) => ({ [c]: { $exists: true } })) };
		const docs = await dp.find(q, { projection: { fecha: 1, ...Object.fromEntries(CAMPOS.map((c) => [c, 1])) } }).toArray();
		for (const d of docs) console.log(`  ${d.fecha.toISOString().slice(0, 7)}  ${CAMPOS.filter((c) => d[c] !== undefined).map((c) => `${c}=${d[c]}`).join(' ')}`);
		console.log(`documentos con algún campo: ${docs.length}`);
		if (APPLY) { const r = await dp.updateMany(q, { $unset: Object.fromEntries(CAMPOS.map((c) => [c, ''])) }); console.log(`campos quitados en ${r.modifiedCount}`); } else console.log('EN SECO: repetir con --revertir --apply');
		await conn.close();
		return;
	}

	const serie = async (s) => Object.fromEntries((await db.collection('indicesmensuales').find({ serie: s, periodo: { $gte: '2023-09', $lte: '2024-04' } }, { projection: { _id: 0, periodo: 1, valor: 1 } }).toArray()).map((x) => [x.periodo, x.valor]));
	const ipc = await serie('ipc');
	const ripte = await serie('ripte');
	console.log('Series oficiales (indicesmensuales):');
	for (const p of ['2023-09', '2023-12', '2024-03', '2024-04']) console.log(`  ${p}  ipc ${ipc[p]}  ripte ${ripte[p]}`);

	const res = calibrar(calcularCoeficientes(ipc, ripte));
	console.log('\nCoeficientes y calibración contra BlueCorp (tolerancia 0,000001):');
	const plan = [];
	for (const c of res) {
		const d = await dp.findOne({ fecha: rango(c.periodo) }, { projection: { fecha: 1, movilidadGeneral: 1, [c.campo]: 1 } });
		plan.push({ ...c, id: d && d._id, actual: d ? d[c.campo] : undefined });
		console.log(`  ${c.periodo}  ${c.campo} = ${c.valor.toFixed(8)}  (${c.formula})  BlueCorp ${c.referencia.toFixed(8)}  dif ${c.diferencia.toExponential(2)}  ${c.ok ? 'ok' : 'DIFIERE'}  · aumento general del mes ${d ? d.movilidadGeneral : '—'}  · actual: ${d ? (d[c.campo] ?? 'sin dato') : 'SIN DOCUMENTO'}`);
	}
	if (res.some((c) => !c.ok)) { console.error('\nLa fórmula no reproduce los coeficientes de BlueCorp: no se escribe nada.'); await conn.close(); process.exit(1); }
	const sinDoc = plan.filter((x) => !x.id);
	if (sinDoc.length) { console.error(`\nFaltan documentos de datosprevisionales para: ${sinDoc.map((x) => x.periodo).join(', ')} — no se escribe nada.`); await conn.close(); process.exit(1); }
	const cambios = plan.filter((x) => x.actual !== x.valor);
	console.log(`\ndocumentos a modificar: ${cambios.length} de ${plan.length} (${cambios.map((x) => x.periodo).join(', ') || 'ninguno'})`);

	if (!APPLY) { console.log('EN SECO: no se escribió nada. Repetir con --apply.'); await conn.close(); return; }
	let n = 0;
	for (const x of cambios) { const r = await dp.updateOne({ _id: x.id }, { $set: { [x.campo]: x.valor } }); n += r.modifiedCount; }
	console.log(`escrito: ${n} de ${cambios.length} documentos. Para deshacer: --revertir --apply`);
	await conn.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
