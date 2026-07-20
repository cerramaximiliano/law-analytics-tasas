/**
 * Sincronización de JUS MZA — envoltorio sobre el sync genérico.
 */

'use strict';

const { obtenerValores } = require('./jusMendozaService');
const { sincronizarValores } = require('./valoresArancelariosSyncService');

function sincronizarJusMendoza({ simular = false } = {}) {
  return sincronizarValores({
    obtener: () => obtenerValores(),
    etiqueta: 'JUS MZA',
    simular
  });
}

module.exports = { sincronizarJusMendoza };
