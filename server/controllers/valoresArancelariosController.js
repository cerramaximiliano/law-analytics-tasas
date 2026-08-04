/**
 * Sync on-demand de valores arancelarios (UMA/JUS/IUS) vía API.
 * Ejecuta los mismos *SyncService que el cron: idempotente, y si aparece un
 * período nuevo dispara post + aviso por correo igual que la corrida programada.
 *
 * Un lock en memoria evita corridas superpuestas (doble click en la UI o
 * request concurrente con el cron dentro del mismo proceso).
 */

'use strict';

const { FUENTES_ARANCELARIAS } = require('../services/scrapers/fuentesArancelarias');
const logger = require('../utils/logger');

const enEjecucion = new Set();

/** POST /api/valores-arancelarios/sync/:clave — sincroniza una jurisdicción. */
exports.sincronizarUna = async (req, res) => {
    const { clave } = req.params;
    const fuente = FUENTES_ARANCELARIAS[clave];

    if (!fuente) {
        return res.status(400).json({
            ok: false,
            error: `Clave desconocida: ${clave}`,
            clavesValidas: Object.keys(FUENTES_ARANCELARIAS)
        });
    }
    if (enEjecucion.has(clave)) {
        return res.status(409).json({ ok: false, error: `Ya hay una sincronización de ${fuente.etiqueta} en curso.` });
    }

    enEjecucion.add(clave);
    try {
        logger.info(`syncManual[${fuente.etiqueta}]: solicitado por ${req.usuario.email}`);
        const resumen = await fuente.ejecutar(false);
        return res.json({ ok: true, clave, etiqueta: fuente.etiqueta, resumen });
    } catch (err) {
        logger.error(`syncManual[${fuente.etiqueta}]: ${err.message}`);
        return res.status(502).json({ ok: false, clave, etiqueta: fuente.etiqueta, error: err.message });
    } finally {
        enEjecucion.delete(clave);
    }
};

/** POST /api/valores-arancelarios/sync — sincroniza todas las jurisdicciones en serie. */
exports.sincronizarTodas = async (req, res) => {
    if (enEjecucion.size > 0) {
        return res.status(409).json({ ok: false, error: 'Ya hay una sincronización en curso.' });
    }

    const claves = Object.keys(FUENTES_ARANCELARIAS);
    claves.forEach((c) => enEjecucion.add(c));
    logger.info(`syncManual[todas]: solicitado por ${req.usuario.email}`);

    const resultados = [];
    try {
        // En serie a propósito: son fuentes externas distintas pero comparten
        // proceso y conexión Mongo; el total ronda los 20-30 segundos.
        for (const clave of claves) {
            const fuente = FUENTES_ARANCELARIAS[clave];
            try {
                const resumen = await fuente.ejecutar(false);
                resultados.push({ clave, etiqueta: fuente.etiqueta, ok: true, resumen });
            } catch (err) {
                logger.error(`syncManual[${fuente.etiqueta}]: ${err.message}`);
                resultados.push({ clave, etiqueta: fuente.etiqueta, ok: false, error: err.message });
            } finally {
                enEjecucion.delete(clave);
            }
        }
    } finally {
        claves.forEach((c) => enEjecucion.delete(c));
    }

    const fallidas = resultados.filter((r) => !r.ok).length;
    return res.json({ ok: fallidas === 0, total: resultados.length, fallidas, resultados });
};
