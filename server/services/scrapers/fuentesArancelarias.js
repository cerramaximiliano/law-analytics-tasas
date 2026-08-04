/**
 * Registry de fuentes arancelarias (UMA, JUS, IUS) — clave canónica → runner.
 * =========================================================================
 * Las claves son las mismas que usa `arancelarios-config.fuentes` y que cada
 * *SyncService declara en su llamada a sincronizarValores. Único lugar a
 * tocar cuando se suma una jurisdicción nueva: el CLI, la API de sync y
 * cualquier consumidor futuro iteran este mapa.
 */

'use strict';

const { sincronizarUma } = require('./umaSyncService');
const { sincronizarJusScba } = require('./jusScbaSyncService');
const { sincronizarJusCordoba } = require('./jusCordobaSyncService');
const { sincronizarJusSantaFe } = require('./jusSantaFeSyncService');
const { sincronizarJusChubut } = require('./jusChubutSyncService');
const { sincronizarIusSalta } = require('./iusSaltaSyncService');
const { sincronizarJusNeuquen } = require('./jusNeuquenSyncService');
const { sincronizarJusRioNegro } = require('./jusRioNegroSyncService');
const { sincronizarJusMendoza } = require('./jusMendozaSyncService');

const FUENTES_ARANCELARIAS = {
    'uma-pjn': { etiqueta: 'UMA PJN', ejecutar: (simular) => sincronizarUma({ ambito: 'PJN', simular }) },
    'uma-caba': { etiqueta: 'UMA CABA', ejecutar: (simular) => sincronizarUma({ ambito: 'CABA', simular }) },
    'jus-pba': { etiqueta: 'JUS PBA', ejecutar: (simular) => sincronizarJusScba({ simular }) },
    'jus-cba': { etiqueta: 'JUS Córdoba', ejecutar: (simular) => sincronizarJusCordoba({ simular }) },
    'jus-sfe': { etiqueta: 'JUS Santa Fe', ejecutar: (simular) => sincronizarJusSantaFe({ simular }) },
    'jus-chu': { etiqueta: 'JUS Chubut', ejecutar: (simular) => sincronizarJusChubut({ simular }) },
    'ius-sal': { etiqueta: 'IUS Salta', ejecutar: (simular) => sincronizarIusSalta({ simular }) },
    'jus-nqn': { etiqueta: 'JUS Neuquén', ejecutar: (simular) => sincronizarJusNeuquen({ simular }) },
    'jus-rn': { etiqueta: 'JUS Río Negro', ejecutar: (simular) => sincronizarJusRioNegro({ simular }) },
    'jus-mza': { etiqueta: 'JUS Mendoza', ejecutar: (simular) => sincronizarJusMendoza({ simular }) }
};

module.exports = { FUENTES_ARANCELARIAS };
