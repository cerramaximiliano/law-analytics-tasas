'use strict';

const TasasConfig = require('../../../models/tasasConfig');
const logger = require('../../../utils/logger');
const { findMissingDataColegio } = require('./colegioService');
const { actualizarTasaEspecifica } = require('./bnaService');
const { findMissingDataServiceBcra } = require('./bcraService');

/**
 * Prioridad de fuentes para relleno de gaps:
 *   1. Servicio nativo (BNA web scraping / BCRA API)
 *   2. Fallback: CPACF (tasas.cpacf.org.ar) o Consejo
 *
 * Lógica:
 *   - Tasas BCRA: findMissingDataServiceBcra puede consultar cualquier rango histórico → es la fuente primaria.
 *   - Tasas BNA: actualizarTasaEspecifica actualiza el dato del día desde BNA → se intenta primero.
 *     Para gaps históricos que persistan, se usa CPACF como fallback.
 *   - tasaPasivaBNA: sin scraper nativo histórico, va directo a CPACF.
 */

// Tasas BCRA: servicio nativo capaz de rellenar histórico completo (BCRA API REST)
const BCRA_NATIVE_MAP = [
	{ tipoTasa: 'tasaPasivaBCRA', idVariable: '43' },
	{ tipoTasa: 'cer',            idVariable: '30' },
	{ tipoTasa: 'icl',            idVariable: '40' },
];

// Tasas BNA + CPACF: nativo (BNA web) como primario, CPACF como fallback histórico
const CPACF_TASA_MAP = [
	{ tipoTasa: 'tasaActivaBNA',      rateId: '1',  bnaCompatible: true  },
	{ tipoTasa: 'tasaPasivaBNA',      rateId: '2',  bnaCompatible: false },
	{ tipoTasa: 'tasaActivaCNAT2658', rateId: '22', bnaCompatible: true  },
	{ tipoTasa: 'tasaActivaCNAT2764', rateId: '23', bnaCompatible: true  },
	{ tipoTasa: 'tasaActivaTnaBNA',   rateId: '25', bnaCompatible: true  },
	// { tipoTasa: 'tasaActivaCNAT2601', rateId: '??' }, // Verificar rate ID en CPACF
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tieneGaps(tipoTasa) {
	const config = await TasasConfig.findOne({ tipoTasa });
	return config && config.fechasFaltantes && config.fechasFaltantes.length > 0;
}

// ─── Relleno por tasa ─────────────────────────────────────────────────────────

/**
 * Rellena los gaps de una tasa específica.
 * Prioridad: servicio nativo primero, CPACF/Consejo como fallback.
 *
 * @param {string} tipoTasa
 * @returns {Promise<{ tipoTasa, ejecutado: boolean, fuente?: string, motivo?: string }>}
 */
async function fillGapsForTasa(tipoTasa) {
	// ── Caso 1: Tasa BCRA — servicio nativo histórico completo ──────────────
	const bcraMapping = BCRA_NATIVE_MAP.find(m => m.tipoTasa === tipoTasa);
	if (bcraMapping) {
		if (!(await tieneGaps(tipoTasa))) {
			return { tipoTasa, ejecutado: false, motivo: 'Sin fechas faltantes' };
		}
		logger.info(`[gapFiller] ${tipoTasa}: intentando relleno nativo BCRA (idVariable: ${bcraMapping.idVariable})`);
		await findMissingDataServiceBcra(tipoTasa, bcraMapping.idVariable);
		return { tipoTasa, ejecutado: true, fuente: 'BCRA' };
	}

	// ── Caso 2: Tasa BNA + CPACF ────────────────────────────────────────────
	const cpacfMapping = CPACF_TASA_MAP.find(m => m.tipoTasa === tipoTasa);
	if (!cpacfMapping) {
		return { tipoTasa, ejecutado: false, motivo: 'Tasa no soportada por ningún servicio de relleno' };
	}

	if (!(await tieneGaps(tipoTasa))) {
		return { tipoTasa, ejecutado: false, motivo: 'Sin fechas faltantes' };
	}

	// Intentar servicio nativo BNA primero (cubre el dato del día actual)
	if (cpacfMapping.bnaCompatible) {
		try {
			logger.info(`[gapFiller] ${tipoTasa}: intentando relleno nativo BNA`);
			await actualizarTasaEspecifica(tipoTasa);
		} catch (err) {
			logger.warn(`[gapFiller] ${tipoTasa}: fallo en relleno nativo BNA: ${err.message}`);
		}
	}

	// Verificar si quedan gaps históricos → usar CPACF como fallback
	if (await tieneGaps(tipoTasa)) {
		logger.info(`[gapFiller] ${tipoTasa}: gaps históricos pendientes, usando CPACF (rateId: ${cpacfMapping.rateId})`);
		await findMissingDataColegio(tipoTasa, cpacfMapping.rateId);
		return { tipoTasa, rateId: cpacfMapping.rateId, ejecutado: true, fuente: cpacfMapping.bnaCompatible ? 'BNA+CPACF' : 'CPACF' };
	}

	return { tipoTasa, ejecutado: true, fuente: 'BNA', motivo: 'Gaps resueltos por servicio nativo BNA' };
}

/**
 * Rellena los gaps de todas las tasas que tengan fechas faltantes.
 * Procesa en serie para no saturar el servidor (Puppeteer + BCRA API).
 *
 * @returns {Promise<{ resultados: Array, procesadas: number, omitidas: number }>}
 */
async function fillAllGaps() {
	logger.info('[gapFiller] Iniciando relleno global de gaps...');

	const resultados = [];
	const todasLasTasas = [
		...BCRA_NATIVE_MAP.map(m => m.tipoTasa),
		...CPACF_TASA_MAP.map(m => m.tipoTasa),
	];

	for (const tipoTasa of todasLasTasas) {
		try {
			const resultado = await fillGapsForTasa(tipoTasa);
			resultados.push(resultado);
			if (resultado.ejecutado) {
				// Pausa entre sesiones para no saturar
				await new Promise(r => setTimeout(r, 3000));
			}
		} catch (error) {
			logger.error(`[gapFiller] Error procesando ${tipoTasa}: ${error.message}`);
			resultados.push({ tipoTasa, ejecutado: false, error: error.message });
		}
	}

	const procesadas = resultados.filter(r => r.ejecutado).length;
	const omitidas = resultados.length - procesadas;

	logger.info(`[gapFiller] Completado: ${procesadas} procesadas, ${omitidas} omitidas`);
	return { resultados, procesadas, omitidas };
}

module.exports = { fillAllGaps, fillGapsForTasa, CPACF_TASA_MAP, BCRA_NATIVE_MAP };
