const { procesarVigenciaTasa } = require('../../../services/scrapers/tasas/bnaService');
const moment = require('moment');
const assert = require('assert');
const sinon = require('sinon');

// Mock para TasasConfig
const configTasaMock = {
    fechaUltima: new Date('2025-04-17'),
    fechasFaltantes: []
};

describe('BNA Service - procesarVigenciaTasa', () => {

    // procesarVigenciaTasa toma "hoy" de new Date(), así que se congela el
    // reloj en la fecha que los escenarios asumen como actual. Mediodía UTC
    // para que la fecha local sea 2025-04-18 en cualquier timezone razonable.
    let clock;

    before(() => {
        clock = sinon.useFakeTimers({
            now: new Date('2025-04-18T12:00:00Z'),
            toFake: ['Date']
        });
    });

    after(() => {
        clock.restore();
    });

    // Función helper para crear datos de tasa simulados
    const crearDatosTasaSimulados = (fechaVigencia) => {
        // Convertir de formato YYYY-MM-DD a objeto Date
        const fecha = new Date(fechaVigencia);

        // Crear el formato DD/MM/YYYY para simular datos extraídos
        const formatoFecha = `${fecha.getUTCDate().toString().padStart(2, '0')}/${(fecha.getUTCMonth() + 1).toString().padStart(2, '0')}/${fecha.getUTCFullYear()}`;

        return {
            fechaVigencia: formatoFecha,
            fechaVigenciaISO: fecha.toISOString(),
            fechaFormateada: fechaVigencia,
            tna: 60.5,
            tem: 5.0,
            tea: 79.58,
            textoOriginal: {
                titulo: `Texto simulado vigente desde el ${formatoFecha}`,
                tna: 'T.N.A. (30 días) = 60.5%',
                tem: 'T.E.M. (30 días) = 5.0%',
                tea: 'T.E.A. = 79.58%'
            }
        };
    };

    it('Debe detectar correctamente fecha futura y generar dias intermedios', () => {
        // Publicación 3 días en el futuro respecto del "hoy" congelado
        const datosTasa = crearDatosTasaSimulados('2025-04-21');

        const resultado = procesarVigenciaTasa(datosTasa, configTasaMock);

        assert.strictEqual(resultado.metaVigencia.esFechaFutura, true);
        assert.strictEqual(resultado.metaVigencia.esFechaPasada, false);
        assert.strictEqual(resultado.metaVigencia.requiereCompletarIntermedio, true);

        // Desde el día siguiente a fechaUltima (2025-04-17) hasta el día
        // anterior a la vigencia (2025-04-21): 18, 19 y 20 de abril
        const fechasGeneradas = resultado.metaVigencia.diasHastaVigencia.map(
            (fecha) => moment.utc(fecha).format('YYYY-MM-DD')
        );
        assert.deepStrictEqual(fechasGeneradas, ['2025-04-18', '2025-04-19', '2025-04-20']);
    });

    it('Debe detectar correctamente fecha pasada y generar dias hasta hoy', () => {
        // Publicación 5 días en el pasado respecto del "hoy" congelado
        const datosTasa = crearDatosTasaSimulados('2025-04-13');

        const resultado = procesarVigenciaTasa(datosTasa, configTasaMock);

        assert.strictEqual(resultado.metaVigencia.esFechaFutura, false);
        assert.strictEqual(resultado.metaVigencia.esFechaPasada, true);
        assert.strictEqual(resultado.metaVigencia.requiereCompletarDesdeVigencia, true);

        // Desde el día siguiente a la vigencia (2025-04-13) hasta hoy
        // inclusive: 14, 15, 16, 17 y 18 de abril
        const fechasGeneradas = resultado.metaVigencia.diasDesdeVigencia.map(
            (fecha) => moment.utc(fecha).format('YYYY-MM-DD')
        );
        assert.deepStrictEqual(fechasGeneradas, ['2025-04-14', '2025-04-15', '2025-04-16', '2025-04-17', '2025-04-18']);
    });

    it('Debe manejar correctamente fecha actual', () => {
        // Publicación con vigencia igual al "hoy" congelado
        const datosTasa = crearDatosTasaSimulados('2025-04-18');

        const resultado = procesarVigenciaTasa(datosTasa, configTasaMock);

        assert.strictEqual(resultado.metaVigencia.esFechaFutura, false);
        assert.strictEqual(resultado.metaVigencia.esFechaPasada, false);
        assert.strictEqual(resultado.metaVigencia.esFechaActual, true);

        // No debería requerir completar días
        assert.strictEqual(resultado.metaVigencia.requiereCompletarIntermedio, undefined);
        assert.strictEqual(resultado.metaVigencia.requiereCompletarDesdeVigencia, undefined);
    });
});
