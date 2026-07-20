/**
 * Sincronización de JUS CHU — envoltorio sobre el sync genérico.
 */

'use strict';

const { obtenerValores } = require('./jusChubutService');
const { sincronizarValores } = require('./valoresArancelariosSyncService');

function sincronizarJusChubut({ simular = false } = {}) {
  return sincronizarValores({
    obtener: () => obtenerValores(),
    etiqueta: 'JUS CHU',
    simular
  });
}

module.exports = { sincronizarJusChubut };
