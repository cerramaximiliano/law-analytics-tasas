/**
 * Sincronización de JUS SFE — envoltorio sobre el sync genérico.
 */

'use strict';

const { obtenerValores } = require('./jusSantaFeService');
const { sincronizarValores } = require('./valoresArancelariosSyncService');

function sincronizarJusSantaFe({ simular = false } = {}) {
  return sincronizarValores({
    obtener: () => obtenerValores(),
    etiqueta: 'JUS SFE',
    clave: 'jus-sfe',
    simular
  });
}

module.exports = { sincronizarJusSantaFe };
