/**
 * Script de migración: completar fechaUltimaCompleta en documentos TasasConfig
 *
 * Para cada TasasConfig con fechaUltimaCompleta nula o undefined, calcula
 * el valor correcto usando la misma lógica que verificarFechasFaltantes():
 *
 *   - Sin fechas faltantes         → fechaUltimaCompleta = fechaUltima
 *   - Gaps después del inicio      → fechaUltimaCompleta = primerGap - 1 día
 *   - Gaps desde el inicio mismo   → fechaUltimaCompleta = null (no hay período continuo)
 *
 * Uso:
 *   node scripts/migrateFechaUltimaCompleta.js
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const moment = require('moment');
const config = require('../server/config');
const TasasConfig = require('../server/models/tasasConfig');

async function run() {
    console.log('Conectando a MongoDB...');
    mongoose.set('strictQuery', false);
    await mongoose.connect(config.mongodb.url);
    console.log('Conectado.\n');

    // Buscar todos los documentos sin fechaUltimaCompleta
    const afectados = await TasasConfig.find({
        $or: [
            { fechaUltimaCompleta: { $exists: false } },
            { fechaUltimaCompleta: null },
        ],
    });

    console.log(`Documentos sin fechaUltimaCompleta: ${afectados.length}`);

    if (afectados.length === 0) {
        console.log('Nada que migrar.');
        await mongoose.disconnect();
        return;
    }

    let actualizados = 0;
    let dejadosEnNull = 0;

    for (const config of afectados) {
        const { tipoTasa, fechaInicio, fechaUltima, fechasFaltantes } = config;

        let nuevaFechaUltimaCompleta;

        if (!fechasFaltantes || fechasFaltantes.length === 0) {
            // Sin gaps → completo hasta la última fecha
            nuevaFechaUltimaCompleta = fechaUltima;
        } else {
            // Ordenar gaps ascendente
            const ordenadas = [...fechasFaltantes].sort((a, b) => a - b);
            const primerGap = ordenadas[0];

            if (primerGap > fechaInicio) {
                // El primer gap es posterior al inicio → hay un período completo inicial
                nuevaFechaUltimaCompleta = moment.utc(primerGap).subtract(1, 'days').startOf('day').toDate();
            } else {
                // El primer gap está en el inicio o antes → no hay período continuo
                nuevaFechaUltimaCompleta = null;
            }
        }

        const valorAnterior = config.fechaUltimaCompleta ?? 'undefined';
        const valorNuevo = nuevaFechaUltimaCompleta
            ? moment.utc(nuevaFechaUltimaCompleta).format('YYYY-MM-DD')
            : 'null (sin período continuo)';

        config.fechaUltimaCompleta = nuevaFechaUltimaCompleta;
        await config.save();

        if (nuevaFechaUltimaCompleta) {
            actualizados++;
        } else {
            dejadosEnNull++;
        }

        console.log(`  [${tipoTasa}]  ${valorAnterior} → ${valorNuevo}`);
    }

    console.log(`\nResumen:`);
    console.log(`  Actualizados con fecha: ${actualizados}`);
    console.log(`  Sin período continuo (null intencional): ${dejadosEnNull}`);
    console.log(`  Total procesados: ${afectados.length}`);

    await mongoose.disconnect();
    console.log('\nDesconectado. Migración completada.');
}

run().catch((err) => {
    console.error('Error durante la migración:', err);
    process.exit(1);
});
