/**
 * Alta y consulta de valores arancelarios (UMA, JUS y afines).
 *
 * Estos valores no se scrapean todavía: los fija una resolución que se publica
 * sin un formato estable, así que se cargan a mano y quedan con la norma y el
 * link que los respaldan. El día que una fuente sea scrapeable, el scraper
 * escribe en esta misma colección y nada de lo que la consume cambia.
 *
 * Uso:
 *   node scripts/valorArancelario.js listar
 *   node scripts/valorArancelario.js listar --unidad UMA --ambito PJN
 *   node scripts/valorArancelario.js vigente --unidad UMA --ambito PJN
 *   node scripts/valorArancelario.js cargar --unidad UMA --ambito PJN \
 *        --valor 61230.45 --desde 2026-07-01 --norma "Res. 1352/26" \
 *        --ley-marco "Ley N° 27.423" \
 *        --descripcion "Unidad de Medida Arancelaria del Poder Judicial de la Nación" \
 *        --fuente https://www.csjn.gov.ar/...
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const ValorArancelario = require('../server/models/valoresArancelarios');

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const k = a.slice(2);
			const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
			out[k] = v;
		} else out._.push(a);
	}
	return out;
}

const fmtFecha = (d) => new Date(d).toISOString().slice(0, 10);
const fmtValor = (n) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2 });

async function listar(args) {
	const filtro = { estado: true };
	if (args.unidad) filtro.unidad = String(args.unidad).toUpperCase();
	if (args.ambito) filtro.ambito = args.ambito;

	const docs = await ValorArancelario.find(filtro).sort({ unidad: 1, ambito: 1, vigenciaDesde: -1 });
	if (!docs.length) {
		console.log('No hay valores cargados con ese filtro.');
		return;
	}
	console.log(`${docs.length} valor(es):\n`);
	for (const d of docs) {
		console.log(
			`  ${d.unidad.padEnd(5)} ${String(d.ambito).padEnd(10)} ${fmtValor(d.valor).padStart(14)}  desde ${fmtFecha(d.vigenciaDesde)}  ${d.norma || '(sin norma)'}`
		);
	}
}

async function vigente(args) {
	if (!args.unidad || !args.ambito) {
		console.error('Faltan --unidad y --ambito.');
		process.exitCode = 1;
		return;
	}
	const d = await ValorArancelario.vigente(args.unidad, args.ambito, args.fecha || new Date());
	if (!d) {
		console.log('No hay ningún valor vigente para esa combinación.');
		return;
	}
	console.log(`${d.unidad} ${d.ambito}: ${fmtValor(d.valor)}`);
	console.log(`  vigente desde ${fmtFecha(d.vigenciaDesde)}`);
	console.log(`  norma:  ${d.norma || '—'}`);
	console.log(`  fuente: ${d.fuente || '—'}`);
}

async function cargar(args) {
	const faltan = ['unidad', 'ambito', 'valor', 'desde'].filter((k) => !args[k]);
	if (faltan.length) {
		console.error(`Faltan: ${faltan.map((f) => '--' + f).join(', ')}`);
		process.exitCode = 1;
		return;
	}
	const valor = Number(args.valor);
	if (!isFinite(valor) || valor <= 0) {
		console.error(`El valor "${args.valor}" no es un número positivo.`);
		process.exitCode = 1;
		return;
	}
	const desde = new Date(args.desde);
	if (isNaN(desde.getTime())) {
		console.error(`La fecha "${args.desde}" no se entiende. Usá AAAA-MM-DD.`);
		process.exitCode = 1;
		return;
	}

	// Se avisa si el valor nuevo no es mayor al anterior. No se bloquea --puede
	// haber una corrección legítima a la baja-- pero un valor arancelario que
	// baja suele ser un error de tipeo, y conviene verlo antes de publicarlo.
	const previo = await ValorArancelario.vigente(args.unidad, args.ambito, desde);
	if (previo && valor <= previo.valor) {
		console.log(
			`Atención: el valor anterior (${fmtValor(previo.valor)} desde ${fmtFecha(previo.vigenciaDesde)}) es mayor o igual al que estás cargando.`
		);
	}

	const doc = await ValorArancelario.findOneAndUpdate(
		{ unidad: String(args.unidad).toUpperCase(), ambito: args.ambito, vigenciaDesde: desde },
		{
			$set: {
				valor,
				norma: args.norma || undefined,
				leyMarco: args['ley-marco'] || undefined,
				descripcion: args.descripcion || undefined,
				fuente: args.fuente || undefined,
				notas: args.notas || undefined,
				estado: true
			}
		},
		{ new: true, upsert: true, setDefaultsOnInsert: true }
	);

	console.log(`Guardado: ${doc.unidad} ${doc.ambito} = ${fmtValor(doc.valor)} desde ${fmtFecha(doc.vigenciaDesde)}`);
	if (previo) {
		const variacion = ((doc.valor / previo.valor - 1) * 100).toFixed(1);
		console.log(`  variación respecto del anterior: ${variacion}%`);
	}
}

const COMANDOS = { listar, vigente, cargar };

async function run() {
	const args = parseArgs(process.argv.slice(2));
	const comando = args._[0];
	const fn = COMANDOS[comando];

	if (!fn) {
		console.log(`Comandos: ${Object.keys(COMANDOS).join(', ')}`);
		console.log('Ver el encabezado del archivo para los ejemplos.');
		return;
	}

	await mongoose.connect(process.env.URLDB);
	try {
		await fn(args);
	} finally {
		await mongoose.connection.close();
	}
}

run().catch((err) => {
	console.error(err.message);
	process.exitCode = 1;
});
