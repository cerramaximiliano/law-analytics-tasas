'use strict';
/**
 * Conciliación de series diarias contra las calculadoras del CPACF (tasas.cpacf.org.ar).
 *
 * Compara, día por día, el valor guardado en `Tasas` con el que usa CPACF (% anual / 365, sin el
 * redondeo a 4 decimales del diario que muestra). Con `aplicar` corrige y guarda el valor anterior
 * en `tasas-conciliaciones` para poder revertir.
 *
 * Origen: validación del 12/10/2026 (backlog la-ads ítem 7, D3). El scraper del BNA copiaba la
 * publicación anterior a días hábiles sin publicación propia capturada y la 2764 se guardaba con
 * 4 decimales. La tarea diaria (taskService: conciliacion-cpacf) revisa los últimos 20 días.
 */

const moment = require('moment');
const mongoose = require('mongoose');
const Tasas = require('../../../models/tasas');
const logger = require('../../../utils/logger');
const { CPACFScraper } = require('./colegioService');

// tipoTasa → calculadora CPACF y desde cuándo conciliar. El valor diario se toma de
// porcentaje_interes_anual / divisor (365 salvo indicación) (sin el redondeo a 4 decimales del diario que muestra CPACF).
const SERIES = {
	tasaActivaCNAT2658: { rateId: '22', inicio: '2017-12-01' },
	tasaActivaCNAT2764: { rateId: '23', inicio: '2022-11-07', capitalizacion: true },
	tasaActivaTnaBNA: { rateId: '25', inicio: '2005-01-01' },
	tasaPasivaBNA: { rateId: '2', inicio: '2005-01-01' },
	// Banco Provincia: CPACF (y nuestra serie) usan año de 360 días
	tasaActivaBP: { rateId: '3', inicio: '2005-01-01', divisor: 360 },
};

const TOLERANCIA = 1e-6; // % diario

const Auditoria = () => mongoose.connection.collection('tasas-conciliaciones');

async function revertir(corrida) {
	const cambios = await Auditoria().find({ corrida, revertido: { $ne: true } }).toArray();
	for (const c of cambios) {
		await Tasas.updateOne(
			{ fecha: c.fecha },
			c.valorAnterior === null
				? { $unset: { [c.campo]: '' }, $set: { [`fuentes.${c.campo}`]: c.fuenteAnterior || null } }
				: { $set: { [c.campo]: c.valorAnterior, [`fuentes.${c.campo}`]: c.fuenteAnterior || null } }
		);
		await Auditoria().updateOne({ _id: c._id }, { $set: { revertido: true, revertidoEn: new Date() } });
	}
	logger.info(`Revertidos ${cambios.length} días de la corrida ${corrida}`);
	return cambios.length;
}

async function detalleCPACF(s, serie, desde, hasta) {
	await s.selectRate(serie.rateId);
	const fi = s.calculatorFormInfo || {};
	const p = { capital: '100000', date_from_0: desde.format('DD/MM/YYYY'), date_to: hasta.format('DD/MM/YYYY') };
	if (fi.capitalizationOptions && fi.capitalizationOptions.length) {
		const sin = fi.capitalizationOptions.find((o) => /ninguna|sin/i.test(o.text));
		p.capitalization = (sin || fi.capitalizationOptions[0]).value;
	}
	// La capitalización no cambia la tasa de cada día, que es lo único que se usa acá
	if (fi.requiresFirstCapitalizationDate) p.date_first_capitalization = p.date_to;
	const r = await s.calcular(p);
	return (r && r.detalles) || [];
}

/**
 * @param {object} p
 * @param {string} p.tipoTasa
 * @param {string} [p.desde] - por defecto, el inicio de la serie
 * @param {string} [p.hasta] - por defecto, ayer
 * @param {boolean} [p.aplicar] - corrige y audita; si no, solo informa
 * @param {number} [p.ventana] - días por consulta a CPACF (60)
 * @param {string} [p.corrida] - id de la corrida para la auditoría
 * @param {boolean} [p.verbose] - imprime el avance por ventana
 */
async function conciliarSerie({ tipoTasa, desde, hasta, aplicar = false, ventana = 60, corrida, verbose = false }) {
	const APPLY = aplicar;
	const VENTANA = ventana;
	const CORRIDA = corrida || `conciliacion-${moment.utc().format('YYYYMMDD-HHmmss')}`;
	const log = (m) => (verbose ? console.log(m) : logger.info(m));
	const serie = SERIES[tipoTasa];
	if (!serie) throw new Error(`Serie no soportada: ${tipoTasa}. Disponibles: ${Object.keys(SERIES).join(', ')}`);
	const inicio = moment.utc(desde || serie.inicio).startOf('day');
	const fin = moment.utc(hasta || moment.utc().subtract(1, 'day').format('YYYY-MM-DD')).startOf('day');
	log(`\n=== ${tipoTasa} (CPACF ${serie.rateId}) ${inicio.format('YYYY-MM-DD')} → ${fin.format('YYYY-MM-DD')} · ${APPLY ? 'APLICAR' : 'PRUEBA'} · corrida ${CORRIDA}`);

	const s = new CPACFScraper();
	const diferencias = [];
	let diasComparados = 0;
	try {
		await s.initialize();
		s.page.on('dialog', async (d) => {
			try {
				await d.accept();
			} catch (e) {}
		});
		await s.login();
		for (let v = inicio.clone(); !v.isAfter(fin); v.add(VENTANA, 'days')) {
			const vFin = moment.min(v.clone().add(VENTANA - 1, 'days'), fin.clone());
			let det = [];
			for (let intento = 1; intento <= 2 && !det.length; intento++) {
				try {
					det = await detalleCPACF(s, serie, v, vFin);
				} catch (e) {
					log(`  ${v.format('YYYY-MM-DD')}: error ${e.message.slice(0, 80)} (intento ${intento})`);
				}
			}
			const nuestros = await Tasas.find({ fecha: { $gte: v.toDate(), $lte: vFin.toDate() } }, { fecha: 1, [tipoTasa]: 1, fuentes: 1 }).lean();
			const porDia = new Map(nuestros.map((d) => [moment.utc(d.fecha).format('YYYY-MM-DD'), d]));
			let difVentana = 0;
			for (const p of det) {
				const anual = Number(p.porcentaje_interes_anual);
				if (!Number.isFinite(anual)) continue;
				const valor = anual / (serie.divisor || 365);
				const pIni = moment.max(moment.utc(p.fecha_desde, 'DD/MM/YYYY'), v);
				const pFin = moment.min(moment.utc(p.fecha_hasta, 'DD/MM/YYYY'), vFin);
				for (let d = pIni.clone(); !d.isAfter(pFin); d.add(1, 'day')) {
					const k = d.format('YYYY-MM-DD');
					const doc = porDia.get(k);
					const actual = doc && doc[tipoTasa] !== undefined ? doc[tipoTasa] : null;
					diasComparados++;
					if (actual === null || Math.abs(actual - valor) > TOLERANCIA) {
						difVentana++;
						diferencias.push({ fecha: k, actual, cpacf: valor, anualCPACF: anual, fuenteActual: doc && doc.fuentes ? doc.fuentes[tipoTasa] : null });
					}
				}
			}
			log(`  ${v.format('YYYY-MM-DD')} → ${vFin.format('YYYY-MM-DD')}: ${det.length} períodos CPACF, ${difVentana} días distintos`);
		}
	} finally {
		await s.close();
	}

	// Resumen: diferencias de redondeo (< 0,0001 % diario) y diferencias reales
	const reales = diferencias.filter((d) => d.actual === null || Math.abs(d.actual - d.cpacf) >= 0.0001);
	log(`\nDías comparados ${diasComparados} · distintos ${diferencias.length} (de valor: ${reales.length}, de redondeo: ${diferencias.length - reales.length})`);
	for (const d of reales.slice(0, 40)) {
		log(`  ${d.fecha}: nuestro ${d.actual === null ? '—' : (d.actual * 365).toFixed(2)} % anual (${d.fuenteActual || 'sin fuente'}) · CPACF ${d.anualCPACF} %`);
	}
	if (reales.length > 40) log(`  … ${reales.length - 40} más`);

	if (APPLY && diferencias.length) {
		for (const d of diferencias) {
			const fecha = moment.utc(d.fecha).startOf('day').toDate();
			await Auditoria().insertOne({ corrida: CORRIDA, campo: tipoTasa, fecha, valorAnterior: d.actual, fuenteAnterior: d.fuenteActual || null, valorNuevo: d.cpacf, creado: new Date() });
			await Tasas.updateOne(
				{ fecha },
				{ $set: { [tipoTasa]: d.cpacf, [`fuentes.${tipoTasa}`]: `CPACF (${CORRIDA})` } },
				{ upsert: true }
			);
		}
		await require('../../../controllers/tasasConfigController').verificarFechasFaltantes(tipoTasa);
		log(`Aplicado: ${diferencias.length} días corregidos. Para revertir: --revertir=${CORRIDA}`);
	}
	return { tipoTasa, corrida: CORRIDA, diasComparados, diferencias, reales: reales.length, aplicado: APPLY && diferencias.length > 0 };
}

/**
 * Tarea diaria: concilia los últimos `dias` días de cada serie y corrige (los días que el scraper
 * del BNA completó con la publicación anterior).
 */
async function conciliarUltimosDias(dias = 20) {
	const resultados = [];
	const corrida = `conciliacion-diaria-${moment.utc().format('YYYYMMDD-HHmmss')}`;
	for (const tipoTasa of Object.keys(SERIES)) {
		try {
			const r = await conciliarSerie({ tipoTasa, desde: moment.utc().subtract(dias, 'days').format('YYYY-MM-DD'), aplicar: true, ventana: dias + 1, corrida });
			resultados.push({ tipoTasa, corregidos: r.diferencias.length });
		} catch (e) {
			logger.error(`Conciliación diaria ${tipoTasa}: ${e.message}`);
			resultados.push({ tipoTasa, error: e.message });
		}
	}
	logger.info(`Conciliación diaria con CPACF: ${JSON.stringify(resultados)}`);
	return resultados;
}


module.exports = { SERIES, conciliarSerie, conciliarUltimosDias, revertir };
