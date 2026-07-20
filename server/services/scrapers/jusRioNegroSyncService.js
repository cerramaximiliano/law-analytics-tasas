/**
 * Sincronización de JUS RN — envoltorio sobre el sync genérico.
 */

'use strict';

const { obtenerValores } = require('./jusRioNegroService');
const { sincronizarValores } = require('./valoresArancelariosSyncService');

function sincronizarJusRioNegro({ simular = false } = {}) {
  return sincronizarValores({
    obtener: () => obtenerValores(),
    etiqueta: 'JUS RN',
    simular
  });
}

module.exports = { sincronizarJusRioNegro };
