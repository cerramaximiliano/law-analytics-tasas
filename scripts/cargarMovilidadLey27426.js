'use strict';
/**
 * Extiende `datosprevisionales.movilidadLey27426` — lo que habría dado la fórmula de la ley
 * 27.426 — más allá de 2020, que era lo único cargado. La usa el retroactivo previsional del
 * hub (criterio `ley_27426_diferido_6_meses`, "Continuidad ley 27.426") y hace falta para el
 * criterio de la CFSS Sala II en "Galletta" (13/11/2026): ley 27.426 continua de enero de 2021
 * a junio de 2024.
 *
 * La serie es DERIVADA: se calcula con las series oficiales que ya mantiene este servicio en
 * `indicesmensuales` (`ipc` del INDEC y `ripte` de la Secretaría de Trabajo):
 *
 *   aumento de marzo / junio / septiembre / diciembre =
 *     70 % de la variación del IPC + 30 % de la variación del RIPTE
 *     del trimestre cerrado seis meses antes (ley 27.426, art. 1)
 *
 * Antes de escribir se calibra contra los ocho aumentos reales de 2018-2019
 * (`datosprevisionales.movilidadGeneral`): si no los reproduce al cuarto decimal, aborta.
 * Los valores de 2020 ya cargados no se tocan; solo se informan al lado del cálculo.
 *
 * Uso (no depende del logger ni del .env de este repo: alcanza con URLDB en el entorno):
 *   node scripts/cargarMovilidadLey27426.js                      # en seco
 *   node scripts/cargarMovilidadLey27426.js --apply
 *   node scripts/cargarMovilidadLey27426.js --hasta 2024-06      # default; tope del período a cargar
 *   node scripts/cargarMovilidadLey27426.js --revertir           # quita el campo de 2021-03 en adelante
 */
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REVERTIR = args.includes('--revertir');
const HASTA = (args[args.indexOf('--hasta') + 1] && args.includes('--hasta')) ? args[args.indexOf('--hasta') + 1] : '2024-06';
const DESDE = '2021-03';

const mes = (p, d) => { const [a, m] = p.split('-').map(Number); const t = a * 12 + m - 1 + d; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const rango = (p) => ({ $gte: new Date(`${p}-01T00:00:00.000Z`), $lt: new Date(`${mes(p, 1)}-01T00:00:00.000Z`) });

(async () => {
	if (!process.env.URLDB) throw new Error('falta URLDB en el entorno');
	const conn = await mongoose.createConnection(process.env.URLDB, { serverSelectionTimeoutMS: 15000 }).asPromise();
	const db = conn.db;
	const dp = db.collection('datosprevisionales');

	if (REVERTIR) {
		const q = { fecha: { $gte: new Date(`${DESDE}-01T00:00:00.000Z`) }, movilidadLey27426: { $exists: true } };
		console.log(`documentos con el campo desde ${DESDE}: ${await dp.countDocuments(q)}`);
		if (APPLY) { const r = await dp.updateMany(q, { $unset: { movilidadLey27426: '' } }); console.log(`campo quitado en ${r.modifiedCount}`); }
		else console.log('EN SECO: repetir con --revertir --apply');
		await conn.close();
		return;
	}

	const serie = async (s) => Object.fromEntries((await db.collection('indicesmensuales').find({ serie: s }, { projection: { _id: 0, periodo: 1, valor: 1 } }).toArray()).map((x) => [x.periodo, x.valor]));
	const ipc = await serie('ipc');
	const ripte = await serie('ripte');
	const formula = (p) => {
		const fin = mes(p, -6), ini = mes(p, -9);
		for (const [n, m] of [['ipc', ipc], ['ripte', ripte]]) for (const q of [ini, fin]) if (!(q in m)) throw new Error(`falta ${n} ${q} en indicesmensuales`);
		return r4(1 + 0.7 * (ipc[fin] / ipc[ini] - 1) + 0.3 * (ripte[fin] / ripte[ini] - 1));
	};
	const guardado = async (p) => dp.findOne({ fecha: rango(p) }, { projection: { fecha: 1, movilidadGeneral: 1, movilidadLey27426: 1 } });

	// 1. Calibración contra lo que efectivamente se pagó con la ley 27.426.
	console.log('Calibración contra los aumentos reales (movilidadGeneral):');
	let ok = true;
	for (let p = '2018-03'; p <= '2019-12'; p = mes(p, 3)) {
		const d = await guardado(p); const c = formula(p);
		const bien = d && Math.abs(c - d.movilidadGeneral) <= 0.00015;
		console.log(`  ${p}  calculado ${c.toFixed(4)}  real ${d ? d.movilidadGeneral : 'sin documento'}  ${bien ? 'ok' : 'DIFIERE'}`);
		ok = ok && bien;
	}
	if (!ok) { console.error('La fórmula no reproduce los aumentos reales: no se escribe nada.'); await conn.close(); process.exit(1); }

	// 2. Lo ya cargado para 2020 (no se toca).
	console.log('\n2020, ya cargado (no se modifica):');
	for (let p = '2020-03'; p <= '2020-12'; p = mes(p, 3)) { const d = await guardado(p); console.log(`  ${p}  cargado ${d?.movilidadLey27426}  calculado ${formula(p).toFixed(4)}`); }

	// 3. Lo que se agrega.
	console.log(`\n${DESDE} a ${HASTA} — a cargar:`);
	const plan = [];
	for (let p = DESDE; p <= HASTA; p = mes(p, 3)) {
		const d = await guardado(p); const v = formula(p);
		plan.push({ p, v, id: d?._id, antes: d?.movilidadLey27426, general: d?.movilidadGeneral });
		console.log(`  ${p}  ley 27.426 ${v.toFixed(4)}  (aumento general ${d ? d.movilidadGeneral : '—'})  actual: ${d ? (d.movilidadLey27426 ?? 'sin dato') : 'SIN DOCUMENTO'}`);
	}
	const acumL = plan.reduce((a, x) => a * x.v, 1), acumG = plan.reduce((a, x) => a * (x.general || 1), 1);
	console.log(`  acumulado: ley 27.426 ×${acumL.toFixed(4)} · aumentos generales del mismo período ×${acumG.toFixed(4)}`);
	const sinDoc = plan.filter((x) => !x.id);
	if (sinDoc.length) { console.error(`Faltan documentos de datosprevisionales para: ${sinDoc.map((x) => x.p).join(', ')} — no se escribe nada.`); await conn.close(); process.exit(1); }

	if (!APPLY) { console.log('\nEN SECO: no se escribió nada. Repetir con --apply.'); await conn.close(); return; }
	let n = 0;
	for (const x of plan) { const r = await dp.updateOne({ _id: x.id }, { $set: { movilidadLey27426: x.v } }); n += r.modifiedCount; }
	console.log(`\nescrito: ${n} de ${plan.length} documentos. Para deshacer: --revertir --apply`);
	await conn.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
