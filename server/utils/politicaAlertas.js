'use strict';

/**
 * Política de envío de los correos de la verificación de tasas: avisar cuando un problema
 * aparece, cuando cambia y cuando se resuelve, en lugar de repetirlo en cada corrida.
 *
 * El "problema" es el conjunto de tasas desactualizadas. Un error de scraping de una tasa que
 * sigue al día (un timeout pasajero de la fuente) no es un problema: el scraper lo reintenta en
 * su próximo ciclo, y si no se recupera la tasa queda desactualizada y ahí sí se avisa.
 *
 * La verificación que manda el reporte diario (`notificarExito`) sale siempre, haya o no
 * problemas; las demás solo cuando el estado cambió respecto del último correo.
 */

/** Firma del problema: tipos de tasa desactualizados, ordenados. Vacía = todo al día. */
function firmaProblema(tasasDesactualizadas = []) {
	return tasasDesactualizadas
		.map((t) => t.tipoTasa)
		.sort()
		.join(',');
}

/** De las tasas con errores de scraping, las que además están desactualizadas. */
function erroresRelevantes(tasasConErrores = [], tasasDesactualizadas = []) {
	const atrasadas = new Set(tasasDesactualizadas.map((t) => t.tipoTasa));
	return tasasConErrores.filter((t) => atrasadas.has(t.tipoTasa));
}

/**
 * @param {Object} p
 * @param {String} p.firma - firma del problema actual ('' si todo está al día)
 * @param {String|null} p.firmaPrevia - firma informada en el último correo (null si no hubo)
 * @param {Boolean} p.notificarExito - la corrida es un reporte diario: sale siempre
 * @returns {'alerta'|'exito'|'resuelto'|null} qué correo mandar
 */
function decidirEnvio({ firma, firmaPrevia = null, notificarExito = false }) {
	if (firma) return notificarExito || firma !== firmaPrevia ? 'alerta' : null;
	if (notificarExito) return 'exito';
	return firmaPrevia ? 'resuelto' : null;
}

// Último estado informado por correo. Vive en memoria: tras un reinicio, un problema en curso
// se vuelve a avisar una vez.
let firmaInformada = null;
const obtenerFirmaInformada = () => firmaInformada;
const registrarFirmaInformada = (firma) => {
	firmaInformada = firma;
};

module.exports = { firmaProblema, erroresRelevantes, decidirEnvio, obtenerFirmaInformada, registrarFirmaInformada };
