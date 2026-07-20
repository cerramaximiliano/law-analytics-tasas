/**
 * Sincronización de JUS NQN — envoltorio sobre el sync genérico.
 */

'use strict';

const { obtenerValores } = require('./jusNeuquenService');
const { sincronizarValores } = require('./valoresArancelariosSyncService');

function sincronizarJusNeuquen({ simular = false } = {}) {
  return sincronizarValores({
    obtener: () => obtenerValores(),
    etiqueta: 'JUS NQN',
    clave: 'jus-nqn',
    simular
  });
}

module.exports = { sincronizarJusNeuquen };
