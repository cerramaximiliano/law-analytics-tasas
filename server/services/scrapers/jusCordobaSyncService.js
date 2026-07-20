/**
 * Sincronización del valor del JUS de Córdoba — envoltorio sobre el sync
 * genérico, atando el scraper del JSON del Poder Judicial de Córdoba.
 */

'use strict';

const { obtenerValores } = require('./jusCordobaService');
const { sincronizarValores } = require('./valoresArancelariosSyncService');

function sincronizarJusCordoba({ simular = false } = {}) {
  return sincronizarValores({
    obtener: () => obtenerValores(),
    etiqueta: 'JUS CBA',
    clave: 'jus-cba',
    simular
  });
}

module.exports = { sincronizarJusCordoba };
